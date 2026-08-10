"""
api_server.py
Registers a single read-only aiohttp endpoint that the frontend polls to
render the dashboard. No mutation endpoints exist by design.
"""

import logging
from aiohttp import web

from .scanner import scan_disk_models, scan_workflows, list_workflow_names
from .tracker import get_history

log = logging.getLogger("ModelAnalytics")


def _build_inventory() -> dict:
    disk_models = scan_disk_models()          # [{kind, rel_path, abs_path, size_bytes}]
    workflow_map = scan_workflows()            # {rel_path_or_name: [workflow_files]}
    history = get_history()                    # {rel_path: {use_count, last_used}}
    workflow_names = list_workflow_names()

    # Build a quick lookup of workflow-referenced names for matching against
    # disk rel_paths. We match on both the full rel_path and just the
    # basename, since workflow JSON does not always store the full
    # subfolder-qualified path.
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

        is_unused = not referenced_in and not hist_entry
        if is_unused:
            total_unused_bytes += model["size_bytes"]

        inventory.append({
            "kind": model["kind"],
            "rel_path": rel_path,
            "size_bytes": model["size_bytes"],
            "workflows": sorted(set(referenced_in)),
            "use_count": hist_entry.get("use_count", 0) if hist_entry else 0,
            "last_used": hist_entry.get("last_used") if hist_entry else None,
            "unused": is_unused,
        })

    return {
        "models": inventory,
        "workflow_names": workflow_names,
        "workflow_map": workflow_map,
        "total_unused_bytes": total_unused_bytes,
        "total_models": len(inventory),
    }


async def get_inventory(request: web.Request) -> web.Response:
    try:
        data = _build_inventory()
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
