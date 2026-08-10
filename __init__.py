"""
ComfyUI Model Analytics Dashboard
Read-only UI extension that shows which models on disk are referenced by
saved workflows and/or were actually loaded at runtime, and which are
sitting unused on disk.

No delete functionality is implemented on purpose.
"""

from .api_server import setup_routes
from .tracker import install_tracker_hooks

# Register API routes and runtime hooks as soon as ComfyUI imports this package.
setup_routes()
install_tracker_hooks()

# Standard ComfyUI custom-node exports. This extension adds no graph nodes,
# only a server extension + frontend patch, so both maps stay empty.
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
