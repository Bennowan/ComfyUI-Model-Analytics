"""
api_server.py
Registers a single read-only aiohttp endpoint that the frontend polls to
render the dashboard. No mutation endpoints exist by design.

Categorization note:
A model is "Used" if EITHER of the following holds, evaluated fresh on
every request (no permanent "used" flag is ever stored):
  1. It was actually loaded recently enough (tracker.py's last_used
     timestamp, checked via tracker.is_recently_used()).
  2. It is still referenced by at least one saved workflow file, per
     scanner.scan_workflows() - regardless of how long ago that workflow
     was last run, or whether it's ever been run at all in a session this
     extension was installed for.
A model only falls into "Unused" when BOTH are false: nothing on disk
currently points to it, and it hasn't been loaded within the recency
window either. Criterion 2 is what keeps a model that's clearly still
wired into a saved workflow from showing up as "wasted disk space" just
because the workflow itself hasn't been (re-)run recently - which used to
be the only thing this endpoint reported (see CHANGELOG / issue reports:
"Used Models" showing empty while the same models were plainly visible
under "Workflow View").

The recency window itself (criterion 1) is configurable per-request via
the `used_threshold_days` query param, and can also be disabled entirely
(see get_inventory() below) so that any model ever loaded - no matter how
long ago - counts as used, without needing a workflow reference.
"""

import math
import logging
from aiohttp import web

from .scanner import scan_disk_models, scan_workflows, list_workflow_names, get_workflows_dir_debug_info
from .tracker import get_history, is_recently_used, get_used_threshold_days

log = logging.getLogger("ModelAnalytics")


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

    # Build a quick lookup of workflow-referenced names for matching against
    # disk rel_paths. We match on both the full rel_path and just the
    # basename, since workflow JSON does not always store the full
    # subfolder-qualified path. This is informational only and never
    # affects the used/unused categorization below.
    workflow_keys_by_basename = {}
    for key in workflow_map:
        basename = key.split("/")[-1]
        workflow_keys_by_basename.setdefault(basename, []).extend(workflow_map[key])

    history_keys_by_basename = {}
    for key in history:
        basename = key.split("/")[-1]
        history_keys_by_basename.setdefault(basename, key)

    inventory = []
    total_unused_bytes = 0
    skipped_models = 0

    for model in disk_models:
        # Each model is processed independently. An unexpected shape for
        # one entry (e.g. a stat race leaving size_bytes as None, or a
        # malformed history entry) must not drop every other model from
        # the response.
        try:
            rel_path = model["rel_path"]
            basename = rel_path.split("/")[-1]

            referenced_in = workflow_map.get(rel_path) or workflow_keys_by_basename.get(basename, [])

            hist_entry = history.get(rel_path)
            if hist_entry is None:
                hist_key = history_keys_by_basename.get(basename)
                hist_entry = history.get(hist_key) if hist_key else None

            last_used_iso = hist_entry.get("last_used") if hist_entry else None
            use_count = hist_entry.get("use_count", 0) if hist_entry else 0

            # Categorization is recalculated fresh every request, never from
            # a persisted "used" flag - but it's now decided by TWO
            # independent signals, either of which is enough to keep a
            # model out of "Unused":
            #   - recently_used: loaded within `threshold_days` (or ever
            #     loaded at all, if the recency window is disabled - see
            #     get_inventory()).
            #   - referenced: at least one saved workflow currently
            #     mentions this file, regardless of how long ago (or
            #     whether) that workflow was actually run.
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
                "workflows": sorted(set(referenced_in)),
                "use_count": use_count,
                "last_used": last_used_iso,
                "unused": is_unused,
                "used_reason": used_reason,
            })
        except Exception:
            skipped_models += 1
            log.exception("Skipping one model entry due to an unexpected error while building inventory: %r", model)
            continue

    if skipped_models:
        log.warning("Skipped %d model(s) while building inventory due to per-item errors", skipped_models)

    # math.inf isn't valid JSON (JS's JSON.parse chokes on a literal
    # `Infinity`), so the "recency filter is disabled" state is encoded as
    # used_threshold_days: null + used_threshold_enabled: false instead of
    # trying to serialize the infinite value itself.
    threshold_disabled = math.isinf(threshold_days)

    return {
        "success": True,
        "models": inventory,
        "workflow_names": workflow_names,
        "workflow_map": workflow_map,
        "total_unused_bytes": total_unused_bytes,
        "total_models": len(inventory),
        "used_threshold_days": None if threshold_disabled else threshold_days,
        "used_threshold_enabled": not threshold_disabled,
        "workflows_debug": workflows_debug,
        "skipped_models": skipped_models,
    }


async def get_inventory(request: web.Request) -> web.Response:
    try:
        # Optional per-request override for experimentation/testing; the
        # persistent, configured value always comes from
        # tracker.get_used_threshold_days() (env var
        # MODEL_ANALYTICS_USED_THRESHOLD_DAYS, default 7).
        #
        # `used_threshold_days` also accepts a handful of "turn the
        # recency window off entirely" spellings (the frontend sends
        # "off" via its optional-filter checkbox), in which case every
        # model that was EVER loaded counts as used regardless of age -
        # see tracker.is_recently_used()'s math.inf handling.
        threshold_days = None
        raw = request.query.get("used_threshold_days")
        if raw is not None:
            normalized = raw.strip().lower()
            if normalized in ("off", "disabled", "none", "unlimited", ""):
                threshold_days = math.inf
            else:
                try:
                    parsed = float(raw)
                    if parsed > 0 and math.isfinite(parsed):
                        threshold_days = parsed
                    # A non-positive, NaN, or "Infinity"-as-a-number value
                    # from a malformed request: fall back to the
                    # configured default rather than 500ing or silently
                    # accepting a nonsensical window.
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

