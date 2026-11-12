"""
api_server.py
Registers a single read-only aiohttp endpoint that the frontend polls to
render the dashboard. No mutation endpoints exist by design.

Categorization note:
A model is "Used" if EITHER of the following holds, evaluated fresh on
every request (no permanent "used" flag is ever stored):
  1. It was loaded recently enough (tracker.py's last_used timestamp,
     checked via tracker.is_recently_used()).
  2. It is referenced by at least one saved workflow file, per
     scanner.scan_workflows() - regardless of when that workflow last ran.
A model is "Unused" only when BOTH are false.

The recency window (criterion 1) is configurable per request via the
`used_threshold_days` query param and can be disabled entirely ("off"),
in which case any model that was ever loaded counts as used.
"""

import math
import logging
from aiohttp import web

from .scanner import scan_disk_models, scan_workflows, list_workflow_names, get_workflows_dir_debug_info
from .tracker import get_history, is_recently_used, get_used_threshold_days

log = logging.getLogger("ModelAnalytics")


_MATCH_RANK = {"exact": 3, "suffix": 2, "basename": 1}


def _match_workflows(rel_path, workflow_map, keys_by_basename, disk_rel_paths, basename_is_unique):
    """Find the saved workflows that reference one disk model.

    ComfyUI's loader dropdowns store the path relative to the model-kind
    root, so an EXACT match on rel_path is the normal case. Weaker
    fallbacks exist for workflows with a different prefix, but they must
    never grab a file that a workflow key already identifies exactly:

      exact    - workflow key == rel_path
      suffix   - workflow key is longer and ends with "/" + rel_path
                 (e.g. "checkpoints/foo.safetensors" vs "foo.safetensors")
      basename - workflow key is a bare file name and rel_path is the only
                 file with that name on disk

    A key that exactly matches some OTHER file on disk belongs to that
    file and is skipped here. Returns (sorted workflow names, best match
    type or None).
    """
    basename = rel_path.rsplit("/", 1)[-1]
    found = set()
    best = None
    for key in keys_by_basename.get(basename, ()):
        if key == rel_path:
            match = "exact"
        elif key in disk_rel_paths:
            continue
        elif key.endswith("/" + rel_path):
            match = "suffix"
        elif key == basename and basename_is_unique:
            match = "basename"
        else:
            continue
        found.update(workflow_map.get(key, ()))
        if best is None or _MATCH_RANK[match] > _MATCH_RANK[best]:
            best = match
    return sorted(found), best


def _build_inventory(threshold_days: float = None) -> dict:
    if threshold_days is None:
        threshold_days = get_used_threshold_days()

    # Each of these four calls is independently defensive internally
    # (scanner.py / tracker.py catch and skip per-item failures), but we
    # additionally isolate them from each other here: if, despite that,
    # one subsystem still raises (e.g. an unexpected folder_paths error
    # on a particular ComfyUI fork), the dashboard still returns partial
    # data for the parts that succeeded instead of a bare 500 with no
    # models at all.
    try:
        disk_models = scan_disk_models()          # [{kind, rel_path, abs_path, size_bytes}]
    except Exception:
        log.exception("Disk model scan failed - returning empty model list")
        disk_models = []

    try:
        workflow_map = scan_workflows()            # {rel_path_or_name: [workflow_files]}
    except Exception:
        log.exception("Workflow scan failed - continuing without workflow references")
        workflow_map = {}

    try:
        history = get_history()                    # {rel_path: {use_count, last_used}}
    except Exception:
        log.exception("Loading model usage history failed - treating all models as never used")
        history = {}

    try:
        workflow_names = list_workflow_names()
    except Exception:
        log.exception("Listing workflow names failed")
        workflow_names = []

    try:
        workflows_debug = get_workflows_dir_debug_info()
    except Exception:
        log.exception("Building workflows debug info failed")
        workflows_debug = {}

    # Lookup tables for matching. "Disabled" files (name.ext.disabled) live
    # in their own bucket and take no part in matching.
    active_models = [m for m in disk_models if not m.get("disabled")]
    disk_rel_paths = {m["rel_path"] for m in active_models if m.get("rel_path")}
    basename_counts = {}
    for rp in disk_rel_paths:
        b = rp.rsplit("/", 1)[-1]
        basename_counts[b] = basename_counts.get(b, 0) + 1

    workflow_keys_by_basename = {}
    for key in workflow_map:
        workflow_keys_by_basename.setdefault(key.rsplit("/", 1)[-1], []).append(key)

    # History keys are normally full relative paths. Keys without a "/"
    # come from tracker._relativize()'s basename fallback and may only be
    # used for a disk file whose name is unique.
    history_bare_keys = {k: v for k, v in history.items() if "/" not in k}

    inventory = []
    total_unused_bytes = 0
    total_disabled_bytes = 0
    disabled_count = 0
    skipped_models = 0

    for model in disk_models:
        # Each model is processed independently. An unexpected shape for
        # one entry (e.g. a stat race leaving size_bytes as None, or a
        # malformed history entry) must not drop every other model from
        # the response.
        try:
            rel_path = model["rel_path"]
            basename = rel_path.rsplit("/", 1)[-1]

            if model.get("disabled"):
                # Disabled files are neither used nor unused - own bucket.
                disabled_size = model.get("size_bytes", 0) or 0
                total_disabled_bytes += disabled_size
                disabled_count += 1
                inventory.append({
                    "kind": model.get("kind", "unknown"),
                    "rel_path": rel_path,
                    "size_bytes": disabled_size,
                    "workflows": [],
                    "workflow_match": None,
                    "use_count": 0,
                    "last_used": None,
                    "unused": False,
                    "disabled": True,
                    "used_reason": None,
                })
                continue

            referenced_in, workflow_match = _match_workflows(
                rel_path,
                workflow_map,
                workflow_keys_by_basename,
                disk_rel_paths,
                basename_counts.get(basename, 0) == 1,
            )

            hist_entry = history.get(rel_path)
            if hist_entry is None and basename_counts.get(basename, 0) == 1:
                hist_entry = history_bare_keys.get(basename)

            last_used_iso = hist_entry.get("last_used") if hist_entry else None
            use_count = hist_entry.get("use_count", 0) if hist_entry else 0

            # Recalculated fresh every request - never from a persisted flag.
            # Either signal is enough to keep a model out of "Unused":
            #   - recently_used: loaded within `threshold_days` (or ever
            #     loaded, if the recency window is disabled).
            #   - referenced: a saved workflow currently mentions this file.
            recently_used = is_recently_used(last_used_iso, threshold_days)
            referenced = bool(referenced_in)
            is_unused = not (recently_used or referenced)
            used_reason = None
            if recently_used and referenced:
                used_reason = "recent_load_and_workflow"
            elif recently_used:
                used_reason = "recent_load"
            elif referenced:
                used_reason = "workflow_reference"

            size_bytes = model.get("size_bytes", 0) or 0
            if is_unused:
                total_unused_bytes += size_bytes

            inventory.append({
                "kind": model.get("kind", "unknown"),
                "rel_path": rel_path,
                "size_bytes": size_bytes,
                "workflows": referenced_in,
                "workflow_match": workflow_match,
                "use_count": use_count,
                "last_used": last_used_iso,
                "unused": is_unused,
                "disabled": False,
                "used_reason": used_reason,
            })
        except Exception:
            skipped_models += 1
            log.exception("Skipping one model entry due to an unexpected error while building inventory: %r", model)
            continue

    if skipped_models:
        log.warning("Skipped %d model(s) while building inventory due to per-item errors", skipped_models)

    # math.inf is not valid JSON, so "recency filter off" is encoded as
    # used_threshold_days: null + used_threshold_enabled: false.
    threshold_disabled = math.isinf(threshold_days)
    return {
        "success": True,
        "models": inventory,
        "workflow_names": workflow_names,
        "workflow_map": workflow_map,
        "total_unused_bytes": total_unused_bytes,
        "total_models": len(inventory) - disabled_count,
        "total_disabled": disabled_count,
        "total_disabled_bytes": total_disabled_bytes,
        "used_threshold_days": None if threshold_disabled else threshold_days,
        "used_threshold_enabled": not threshold_disabled,
        "workflows_debug": workflows_debug,
        "skipped_models": skipped_models,
    }


async def get_inventory(request: web.Request) -> web.Response:
    try:
        # The dashboard sends its chosen window with every request. Without
        # the parameter, tracker.get_used_threshold_days() (default 7) is used.
        threshold_days = None
        raw = request.query.get("used_threshold_days")
        if raw is not None:
            normalized = raw.strip().lower()
            if normalized in ("off", "disabled", "none", "unlimited"):
                threshold_days = math.inf
            else:
                # Empty, non-numeric, non-positive, NaN or infinite values
                # fall back to the configured default instead of silently
                # disabling the filter or returning a 500.
                try:
                    parsed = float(normalized)
                    if parsed > 0 and math.isfinite(parsed):
                        threshold_days = parsed
                except ValueError:
                    pass
        data = _build_inventory(threshold_days=threshold_days)
        return web.json_response(data)
    except Exception as e:
        # _build_inventory() already isolates and logs its own internal
        # failures per subsystem/per-model, so reaching this point means
        # something genuinely unexpected happened outside those guarded
        # sections. Log the full traceback server-side for debugging, but
        # never leak it (or raw absolute filesystem paths) into the HTTP
        # response - the frontend only gets a safe, human-readable summary.
        log.exception("Failed to build model inventory")
        error_payload = {
            "success": False,
            "error": f"{type(e).__name__}: {e}",
            "error_type": type(e).__name__,
            "hint": "Check the ComfyUI server console/log for the full traceback.",
        }
        return web.json_response(error_payload, status=500)


def setup_routes() -> None:
    try:
        from server import PromptServer
    except ImportError:
        log.warning("server.PromptServer not importable - API routes not registered "
                    "(running outside ComfyUI?)")
        return

    routes = PromptServer.instance.routes

    @routes.get("/model_analytics/inventory")
    async def _inventory_route(request: web.Request) -> web.Response:
        return await get_inventory(request)

