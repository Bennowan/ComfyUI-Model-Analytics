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

    disk_models = scan_disk_models()          # [{kind, rel_path, abs_path, size_bytes}]
    workflow_map = scan_workflows()            # {rel_path_or_name: [workflow_files]}
    history = get_history()                    # {rel_path: {use_count, last_used}}
    workflow_names = list_workflow_names()

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

    for model in disk_models:
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

        if is_unused:
            total_unused_bytes += model["size_bytes"]

        inventory.append({
            "kind": model["kind"],
            "rel_path": rel_path,
            "size_bytes": model["size_bytes"],
            "workflows": sorted(set(referenced_in)),
            "use_count": use_count,
            "last_used": last_used_iso,
            "unused": is_unused,
        })

    return {
        "models": inventory,
        "workflow_names": workflow_names,
        "workflow_map": workflow_map,
        "total_unused_bytes": total_unused_bytes,
        "total_models": len(inventory),
        "used_threshold_days": threshold_days,
        "workflows_debug": get_workflows_dir_debug_info(),
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
        log.exception("Failed to build model inventory")
        return web.json_response({"error": str(e)}, status=500)


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

