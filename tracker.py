"""
tracker.py
Live-tracking of models that are actually loaded into VRAM at runtime,
persisted to model_history.json so that history survives restarts.

The history file intentionally lives under folder_paths.get_user_directory()
(NOT inside custom_nodes/) to avoid permission-denied errors in Docker
setups where the container user differs from the image-build user.
"""

import os
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Dict, Any

try:
    import folder_paths
except ImportError:
    folder_paths = None

log = logging.getLogger("ModelAnalytics")

_lock = threading.Lock()
_history_cache: Dict[str, Any] = {}
_history_loaded = False


def _history_path() -> str:
    if folder_paths is None:
        return os.path.join(os.getcwd(), "model_history.json")
    return os.path.join(folder_paths.get_user_directory(), "model_history.json")


def _load_history() -> Dict[str, Any]:
    global _history_cache, _history_loaded
    if _history_loaded:
        return _history_cache
    path = _history_path()
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                _history_cache = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            log.warning("Could not read model_history.json, starting fresh: %s", e)
            _history_cache = {}
    else:
        _history_cache = {}
    _history_loaded = True
    return _history_cache


def _save_history() -> None:
    path = _history_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(_history_cache, f, indent=2)
        os.replace(tmp_path, path)
    except OSError as e:
        log.error("Could not persist model_history.json: %s", e)


def record_model_loaded(model_key: str) -> None:
    """
    Register that a model was successfully loaded (e.g. into VRAM).
    model_key should be a relative path such as "unet/Wan2.2-I2V.gguf" so it
    lines up with the workflow-scan keys and disk-scan rel_paths.
    """
    if not model_key:
        return
    normalized = model_key.replace("\\", "/")
    with _lock:
        history = _load_history()
        entry = history.get(normalized, {"use_count": 0, "last_used": None})
        entry["use_count"] = entry.get("use_count", 0) + 1
        entry["last_used"] = datetime.now(timezone.utc).isoformat()
        history[normalized] = entry
        _save_history()


def get_history() -> Dict[str, Any]:
    with _lock:
        return dict(_load_history())


def _relativize(full_path: str) -> str:
    """Best-effort: turn an absolute model path into the same relative form
    used elsewhere (kind/subfolder/file.ext), by matching it against known
    folder_paths roots. Falls back to just the basename."""
    if folder_paths is None:
        return os.path.basename(full_path)
    try:
        for _kind, (dirs, _exts) in folder_paths.folder_names_and_paths.items():
            for root_dir in dirs:
                if not root_dir:
                    continue
                try:
                    common = os.path.commonpath([os.path.abspath(full_path), os.path.abspath(root_dir)])
                except ValueError:
                    continue
                if common == os.path.abspath(root_dir):
                    rel = os.path.relpath(full_path, root_dir).replace(os.sep, "/")
                    return rel
    except Exception as e:
        log.debug("Could not relativize %s: %s", full_path, e)
    return os.path.basename(full_path)


def install_tracker_hooks() -> None:
    """
    Hook into ComfyUI's model-management layer so we record a model as
    "used" only once it has actually been loaded (e.g. into VRAM) - not
    merely when a prompt referencing it is queued. This avoids polluting
    the history with aborted/never-run generations.

    We patch comfy.sd.load_checkpoint_guess_config (used for checkpoints)
    and comfy.utils.load_torch_file (used for many loaders: LoRA, VAE,
    UNet, CLIP, ControlNet, etc.) since both ultimately run for a
    successful load. Patching is done defensively - if ComfyUI's internal
    APIs differ from what we expect, we log a warning and simply skip
    live tracking rather than breaking startup.
    """
    try:
        import comfy.utils as comfy_utils
    except ImportError:
        log.warning("comfy.utils not importable - live tracking disabled (running outside ComfyUI?)")
        return

    if getattr(comfy_utils, "_model_analytics_patched", False):
        return  # avoid double-patching on hot reload

    original_load_torch_file = comfy_utils.load_torch_file

    def patched_load_torch_file(ckpt, *args, **kwargs):
        result = original_load_torch_file(ckpt, *args, **kwargs)
        try:
            path_arg = ckpt if isinstance(ckpt, str) else None
            if path_arg:
                record_model_loaded(_relativize(path_arg))
        except Exception as e:
            log.debug("Tracker hook failed for %s: %s", ckpt, e)
        return result

    comfy_utils.load_torch_file = patched_load_torch_file
    comfy_utils._model_analytics_patched = True
    log.info("Model Analytics: live tracking hook installed on comfy.utils.load_torch_file")
