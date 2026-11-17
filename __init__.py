"""
ComfyUI Model Analytics Dashboard
Local analytics extension for ComfyUI model inventory and custom-node use.
The dashboard reads model/workflow state and separately records successful
custom-node execution steps; it does not alter workflows, models or packages.
"""

from .api_server import setup_routes
from .tracker import install_tracker_hooks
from .custom_node_analytics import install_execution_hook

# Register API routes and runtime hooks as soon as ComfyUI imports this package.
setup_routes()
install_tracker_hooks()
install_execution_hook()

# Standard ComfyUI custom-node exports. This extension adds no graph nodes,
# only a server extension + frontend patch, so both maps stay empty.
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
