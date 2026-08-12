"""
api_server.py
Registers a single read-only aiohttp endpoint that the frontend polls to
render the dashboard. No mutation endpoints exist by design.

Categorization note:
Whether a model is "Used" or "Unused" is decided ONLY by how recently it
was actually loaded (tracker.py's last_used timestamp), evaluated fresh on
every request via tracker.is_recently_used(). No permanent "used" flag is
ever stored - a model that hasn't been loaded again within the configured
threshold automatically falls back to Unused, even if it's still
referenced by a saved workflow. Workflow references are surfaced purely
as informational metadata in the "workflows" field.
"""

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

            # Categorization is recalculated fresh every request from the
            # stored timestamp - never from a persisted "used" flag. A model
            # never loaded, or not loaded within `threshold_days`, is unused -
            # regardless of whether it's still referenced by a workflow.
            recently_used = is_recently_used(last_used_iso, threshold_days)
            is_unused = not recently_used

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
            })
        except Exception:
            skipped_models += 1
            log.exception("Skipping one model entry due to an unexpected error while building inventory: %r", model)
            continue

    if skipped_models:
        log.warning("Skipped %d model(s) while building inventory due to per-item errors", skipped_models)

    return {
        "success": True,
        "models": inventory,
        "workflow_names": workflow_names,
        "workflow_map": workflow_map,
        "total_unused_bytes": total_unused_bytes,
        "total_models": len(inventory),
        "used_threshold_days": threshold_days,
        "workflows_debug": workflows_debug,
        "skipped_models": skipped_models,
    }


async def get_inventory(request: web.Request) -> web.Response:
    try:
        # Optional per-request override for experimentation/testing; the
        # persistent, configured value always comes from
        # tracker.get_used_threshold_days() (env var
        # MODEL_ANALYTICS_USED_THRESHOLD_DAYS, default 7).
        threshold_days = None
        raw = request.query.get("used_threshold_days")
        if raw is not None:
            try:
                threshold_days = float(raw)
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

