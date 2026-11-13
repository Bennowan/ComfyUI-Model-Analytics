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
import math
import logging
import threading
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional

try:
    import folder_paths
except ImportError:
    folder_paths = None

try:
    from .scanner import is_excluded_scan_path, iter_model_strings
except ImportError:
    # Fallback if scanner.py isn't importable in this context for some
    # reason - keep tracker.py functional (just without the extra
    # custom_nodes/.disabled guard) rather than crashing on import.
    def is_excluded_scan_path(path: Path) -> bool:
        parts = {p.lower() for p in Path(path).parts}
        return bool(parts & {"custom_nodes", ".disabled"})

    _FALLBACK_EXTS = (".safetensors", ".ckpt", ".gguf", ".pt", ".pth", ".sft", ".onnx", ".bin")

    def iter_model_strings(obj):
        if isinstance(obj, dict):
            for v in obj.values():
                yield from iter_model_strings(v)
        elif isinstance(obj, list):
            for v in obj:
                yield from iter_model_strings(v)
        elif isinstance(obj, str) and obj.lower().endswith(_FALLBACK_EXTS):
            yield obj

log = logging.getLogger("ModelAnalytics")

_lock = threading.Lock()
_history_cache: Dict[str, Any] = {}
_history_loaded = False
# mtime of model_history.json as of the last time we loaded it into
# _history_cache. Used to detect if the file was changed on disk by
# something other than this process (multi-worker setups, manual edits,
# restores, etc.) so we never serve a stale in-memory copy forever.
_history_loaded_mtime: Optional[float] = None

# How many days a model counts as "used" after its last load, before it
# falls back into "Unused Models". This is only the default: the dashboard
# sends its own value with every request (and remembers it in the browser).
DEFAULT_USED_THRESHOLD_DAYS = 7


def get_used_threshold_days() -> float:
    """Default recency window in days, used when a request does not
    specify one. The window is adjusted in the dashboard."""
    return float(DEFAULT_USED_THRESHOLD_DAYS)


def _parse_last_used(last_used: Optional[str]) -> Optional[datetime]:
    if not last_used:
        return None
    try:
        dt = datetime.fromisoformat(last_used)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        # ValueError: malformed ISO string. TypeError: last_used wasn't a
        # string at all (e.g. a legacy/corrupt history entry stored a
        # number or null) - fromisoformat() raises TypeError for that,
        # not ValueError, so both must be caught to avoid a crash.
        log.debug("Could not parse last_used timestamp: %r", last_used)
        return None


def is_recently_used(last_used: Optional[str], threshold_days: Optional[float] = None) -> bool:
    """
    Dynamically decides whether a model counts as 'used' right now, based
    purely on how long ago it was last loaded - never on a stored flag.
    A model with no last_used timestamp (never loaded) is never "recently
    used". A model last loaded more than `threshold_days` ago falls back
    to unused automatically, with no permanent state involved.

    threshold_days:
      - None (default): resolve the configured default via
        get_used_threshold_days() (the 7-day default).
      - a positive, finite number: the normal recency window, in days.
      - math.inf: the recency window is disabled - any model that was
        EVER loaded counts as "recently used", no matter how long ago.
    """
    dt = _parse_last_used(last_used)
    if dt is None:
        return False
    if threshold_days is None:
        threshold_days = get_used_threshold_days()
    if math.isinf(threshold_days):
        # timedelta(days=inf) raises OverflowError, so handle this before
        # the arithmetic below.
        return True
    age = datetime.now(timezone.utc) - dt
    return age <= timedelta(days=threshold_days)


def _history_path() -> str:
    if folder_paths is None:
        return os.path.join(os.getcwd(), "model_history.json")
    try:
        return os.path.join(folder_paths.get_user_directory(), "model_history.json")
    except Exception as e:
        # Some ComfyUI forks/configurations could raise here (e.g. a
        # misconfigured or missing user directory setting). Fall back to
        # the current working directory rather than letting this crash
        # every call site that needs the history path.
        log.warning("Could not resolve ComfyUI user directory, falling back to cwd: %s", e)
        return os.path.join(os.getcwd(), "model_history.json")


def _load_history() -> Dict[str, Any]:
    """
    Load model_history.json into the in-memory cache.

    Previously this only loaded once per process (guarded by
    `_history_loaded`) and then served the same in-memory dict forever,
    even if the file on disk changed underneath it (e.g. a second
    ComfyUI worker process writing history, the file being restored from
    backup, or a manual edit). That meant last_used updates written by
    anything other than *this* process/object were silently ignored,
    which could make a model look permanently stuck in one category.

    Now we compare the file's mtime on every call and reload whenever it
    has changed, so the in-memory cache can never drift from disk for
    longer than a single request.
    """
    global _history_cache, _history_loaded, _history_loaded_mtime
    path = _history_path()

    try:
        current_mtime = os.path.getmtime(path)
    except OSError:
        current_mtime = None

    if _history_loaded and current_mtime == _history_loaded_mtime:
        return _history_cache

    if current_mtime is not None:
        try:
            with open(path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if not isinstance(loaded, dict):
                # Valid JSON but the wrong shape (e.g. "[]", "null", or a
                # bare string) - can happen from a manual edit or a
                # corrupted write. json.JSONDecodeError doesn't catch
                # this since the JSON itself parses fine; without this
                # check, _migrate_history_entries()'s history.items()
                # would raise AttributeError and take down every request.
                log.warning(
                    "model_history.json did not contain a JSON object (got %s) - starting fresh",
                    type(loaded).__name__,
                )
                loaded = {}
            _history_cache = loaded
        except (OSError, json.JSONDecodeError) as e:
            log.warning("Could not read model_history.json, starting fresh: %s", e)
            _history_cache = {}
    else:
        _history_cache = {}

    _history_loaded = True
    _history_loaded_mtime = current_mtime
    return _history_cache


def _save_history() -> None:
    global _history_loaded_mtime
    path = _history_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(_history_cache, f, indent=2)
        os.replace(tmp_path, path)
        # Record the mtime of what we just wrote so the next _load_history()
        # call in this process recognizes its own write and doesn't treat
        # it as an external change requiring a reload.
        try:
            _history_loaded_mtime = os.path.getmtime(path)
        except OSError:
            _history_loaded_mtime = None
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


def record_models_queued(model_keys) -> None:
    """Register that a prompt referencing these models was queued.

    Complements record_model_loaded(): ComfyUI keeps models in memory and
    does not reload them when a cached graph runs again, and loaders that
    bypass comfy.utils.load_torch_file (e.g. GGUF) are never seen by the
    load hook. A queued prompt that names the model catches both cases.
    It only shows intent - a prompt can still fail or be cancelled - which
    is why it is stored in its own fields (last_queued / queue_count)."""
    keys = {k.replace("\\", "/") for k in model_keys if k}
    if not keys:
        return
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        history = _load_history()
        for key in keys:
            entry = history.get(key)
            if not isinstance(entry, dict):
                entry = {"use_count": 0, "last_used": None}
            entry["queue_count"] = entry.get("queue_count", 0) + 1
            entry["last_queued"] = now
            history[key] = entry
        _save_history()


def _on_prompt(json_data):
    """ComfyUI on-prompt handler: record every model file named in the
    queued prompt, then hand the data back untouched."""
    try:
        prompt = json_data.get("prompt") if isinstance(json_data, dict) else None
        if isinstance(prompt, dict):
            record_models_queued(iter_model_strings(prompt))
    except Exception as e:
        log.debug("Queue tracking failed: %s", e)
    return json_data


def latest_timestamp(*values: Optional[str]) -> Optional[str]:
    """The most recent of several ISO timestamps (ignoring missing or
    malformed ones), returned in its original string form."""
    best_dt = None
    best_raw = None
    for raw in values:
        dt = _parse_last_used(raw)
        if dt is not None and (best_dt is None or dt > best_dt):
            best_dt, best_raw = dt, raw
    return best_raw


def get_history() -> Dict[str, Any]:
    with _lock:
        history = _load_history()
        _migrate_history_entries(history)
        return dict(history)


def _migrate_history_entries(history: Dict[str, Any]) -> None:
    """
    Backward-compat migration for history files written by older versions
    of this extension.

    Older entries are already {"use_count": int, "last_used": iso-str},
    which is exactly the shape we still use - so there's nothing to
    transform structurally. This function exists as an explicit migration
    point (and defensively normalizes malformed/partial entries) so that
    future schema changes have a single safe place to land, and so a
    corrupt/older entry never crashes categorization.
    """
    for key, entry in list(history.items()):
        if not isinstance(entry, dict):
            history[key] = {"use_count": 0, "last_used": None}
            continue
        entry.setdefault("use_count", 0)
        entry.setdefault("last_used", None)
        entry.setdefault("queue_count", 0)
        entry.setdefault("last_queued", None)


def _relativize(full_path: str) -> str:
    """Best-effort: turn an absolute model path into the same relative form
    used elsewhere (kind/subfolder/file.ext), by matching it against known
    folder_paths roots. Falls back to just the basename.

    Skips excluded locations (custom_nodes/, .disabled/, etc.) using the
    same rule as scanner.py, so a custom node's bundled model loaded at
    runtime is not written into model_history.json under a relative key."""
    if folder_paths is None:
        return Path(full_path).name
    try:
        target = Path(full_path).resolve()
        if is_excluded_scan_path(target):
            return Path(full_path).name
        known_keys = list(getattr(folder_paths, "folder_names_and_paths", {}).keys())
        for kind in known_keys:
            try:
                root_dirs = folder_paths.get_folder_paths(kind)
            except Exception:
                continue
            for root_dir in root_dirs:
                root = Path(root_dir).resolve()
                if is_excluded_scan_path(root):
                    continue
                try:
                    return target.relative_to(root).as_posix()
                except ValueError:
                    continue
    except Exception as e:
        log.debug("Could not relativize %s: %s", full_path, e)
    return Path(full_path).name


def install_tracker_hooks() -> None:
    """
    Hook into ComfyUI's model-management layer so we record a model as
    "used" only once it has actually been loaded (e.g. into VRAM) - not
    merely when a prompt referencing it is queued. This avoids polluting
    the history with aborted/never-run generations.

    We patch comfy.utils.load_torch_file (used by most loaders: checkpoints,
    LoRA, VAE, UNet, CLIP, ControlNet, ...). Loaders that bypass it (GGUF)
    and models that stay cached in memory are covered by queue tracking
    (_on_prompt), which is stored separately. Patching is done defensively - if ComfyUI's internal
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

    # Queue-time tracking through ComfyUI's official on-prompt handler API.
    try:
        from server import PromptServer
        PromptServer.instance.add_on_prompt_handler(_on_prompt)
        log.info("Model Analytics: queue tracking registered")
    except Exception as e:
        log.warning("Queue tracking not available: %s", e)
