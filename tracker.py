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
_usage_event_index: Dict[str, Dict[str, Any]] = {}

_HISTORY_SCHEMA_VERSION = 2
USAGE_SOURCE_IDS = ("frontend", "api", "unknown")

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


def _normalize_usage_events(raw_events: Any) -> list[Dict[str, Any]]:
    """Validate and deduplicate persisted events by prompt id.

    A prompt id represents one accepted workflow execution. Its model list is
    a set, so repeated references to the same model never inflate usage.
    """
    merged: Dict[str, Dict[str, Any]] = {}
    if not isinstance(raw_events, list):
        return []
    for raw_event in raw_events:
        if not isinstance(raw_event, dict):
            continue
        prompt_id = raw_event.get("prompt_id")
        if not isinstance(prompt_id, str) or not prompt_id.strip():
            continue
        prompt_id = prompt_id.strip()
        raw_models = raw_event.get("models", [])
        if not isinstance(raw_models, list):
            raw_models = []
        model_ids = sorted({
            _normalize_model_key(item)
            for item in raw_models
            if _normalize_model_key(item)
        })
        source_value = raw_event.get("source")
        source_value = source_value.lower() if isinstance(source_value, str) else ""
        source_raw = raw_event.get("source_raw")
        if source_value not in USAGE_SOURCE_IDS:
            # Migrate legacy CLI, MCP, Other, and unknown source identifiers
            # into the single Unknown bucket. Never infer a new category.
            source_value, source_raw = classify_usage_source(source_raw or source_value)
        elif source_value == "unknown":
            # Unknown events should not retain unsupported/raw client labels.
            source_raw = None
        elif not isinstance(source_raw, str):
            source_raw = source_value
        timestamp = raw_event.get("timestamp")
        if not isinstance(timestamp, str) or not timestamp.strip():
            timestamp = None
        current = merged.get(prompt_id)
        if current is None:
            merged[prompt_id] = {
                "prompt_id": prompt_id,
                "timestamp": timestamp,
                "source": source_value,
                "source_raw": source_raw if isinstance(source_raw, str) else None,
                "models": model_ids,
            }
            continue
        current["models"] = sorted(set(current["models"]).union(model_ids))
        if current.get("source") == "unknown" and source_value != "unknown":
            current["source"] = source_value
            current["source_raw"] = source_raw if isinstance(source_raw, str) else None
        if not current.get("timestamp") and timestamp:
            current["timestamp"] = timestamp
    return list(merged.values())


def _normalize_history_database(loaded: Dict[str, Any]) -> Dict[str, Any]:
    """Return the current unified history shape, migrating the legacy
    model-keyed JSON object without discarding existing counters.

    Legacy queue_count values have no prompt id or source. Preserve them as
    timestamp-less Unknown model uses; never infer their source or fabricate
    execution timestamps.
    """
    if loaded.get("schema_version") == _HISTORY_SCHEMA_VERSION and isinstance(loaded.get("models"), dict):
        models = loaded.get("models", {})
        events = _normalize_usage_events(loaded.get("usage_events", []))
        return {
            "schema_version": _HISTORY_SCHEMA_VERSION,
            "models": models,
            "usage_events": events,
        }

    models: Dict[str, Any] = {}
    for key, value in loaded.items():
        if not isinstance(key, str) or not isinstance(value, dict):
            continue
        entry = dict(value)
        try:
            legacy_count = max(0, int(entry.get("queue_count", 0) or 0))
        except (TypeError, ValueError, OverflowError):
            legacy_count = 0
        entry.setdefault("legacy_unknown_usage_count", legacy_count)
        models[key] = entry

    return {
        "schema_version": _HISTORY_SCHEMA_VERSION,
        "models": models,
        "usage_events": _normalize_usage_events(loaded.get("usage_events", [])),
    }


def _load_history() -> Dict[str, Any]:
    """Load the unified model/usage database and refresh its cache whenever
    the file mtime changes (including external process updates)."""
    global _history_cache, _history_loaded, _history_loaded_mtime, _usage_event_index
    path = _history_path()

    try:
        current_mtime = os.path.getmtime(path)
    except OSError:
        current_mtime = None

    if _history_loaded and current_mtime == _history_loaded_mtime:
        return _history_cache

    loaded: Dict[str, Any] = {}
    if current_mtime is not None:
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                loaded = raw
            else:
                log.warning(
                    "model_history.json did not contain a JSON object (got %s) - starting fresh",
                    type(raw).__name__,
                )
        except (OSError, json.JSONDecodeError) as e:
            log.warning("Could not read model_history.json, starting fresh: %s", e)

    _history_cache = _normalize_history_database(loaded)
    source_events_need_migration = (
        loaded.get("schema_version") == _HISTORY_SCHEMA_VERSION
        and loaded.get("usage_events", []) != _history_cache.get("usage_events", [])
    )
    _usage_event_index = {
        event.get("prompt_id"): event
        for event in _history_cache.get("usage_events", [])
        if isinstance(event, dict) and isinstance(event.get("prompt_id"), str)
    }
    _history_loaded = True
    _history_loaded_mtime = current_mtime
    if source_events_need_migration:
        # Convert old CLI/MCP/Other labels to Unknown in-place without
        # clearing model history or inventing source information.
        _save_history()
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
    """Register a model successfully loaded by ComfyUI's loader hook."""
    if not model_key:
        return
    normalized = _normalize_model_key(model_key)
    with _lock:
        database = _load_history()
        models = database["models"]
        entry = models.get(normalized, {"use_count": 0, "last_used": None})
        entry["use_count"] = entry.get("use_count", 0) + 1
        entry["last_used"] = datetime.now(timezone.utc).isoformat()
        models[normalized] = entry
        _save_history()

def record_models_queued(model_keys) -> None:
    """Record queue intent using the existing model-string identification."""
    keys = {_normalize_model_key(k) for k in model_keys if k}
    keys.discard("")
    if not keys:
        return
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        database = _load_history()
        models = database["models"]
        for key in keys:
            entry = models.get(key)
            if not isinstance(entry, dict):
                entry = {"use_count": 0, "last_used": None}
            entry["queue_count"] = entry.get("queue_count", 0) + 1
            entry["last_queued"] = now
            models[key] = entry
        _save_history()


def _normalize_model_key(value: Any) -> str:
    return str(value).strip().replace("\\", "/") if value is not None else ""


def classify_usage_source(raw_source: Any) -> tuple[str, Optional[str]]:
    """Map only explicitly identifiable clients to supported sources.

    ComfyUI 0.43.0 forwards ``Comfy-Usage-Source`` into ``extra_data`` when
    a client supplies it. The built-in frontend identifies itself with
    ``comfyui-frontend``. API is recorded only when an API client explicitly
    sends an API marker; missing and unsupported values remain Unknown.
    """
    raw = raw_source.strip() if isinstance(raw_source, str) else ""
    normalized = raw.lower()
    aliases = {
        "comfyui-frontend": "frontend",
        "frontend": "frontend",
        "comfy-frontend": "frontend",
        "api": "api",
        "comfyui-api": "api",
        "comfy-api": "api",
    }
    category = aliases.get(normalized, "unknown")
    return category, raw[:128] if category != "unknown" and raw else None


def infer_usage_source(raw_source: Any, extra_data: Any) -> tuple[str, Optional[str]]:
    """Resolve the usage source of a started prompt.

    1. An explicit ``comfy_usage_source`` marker always wins and is mapped
       by classify_usage_source() (unrecognized markers stay Unknown).
    2. Without any marker the origin is derived from the request itself:
       the ComfyUI web interface always attaches the workflow as
       ``extra_data.extra_pnginfo``; a plain external call to ``/prompt``
       (curl, scripts, other tools) does not. Prompts without a marker and
       without that workflow data are therefore counted as API.
    """
    if isinstance(raw_source, str) and raw_source.strip():
        return classify_usage_source(raw_source)
    if not isinstance(extra_data, dict):
        return "unknown", None
    if isinstance(extra_data.get("extra_pnginfo"), dict):
        return "frontend", "inferred-frontend"
    return "api", "inferred-api"


def record_prompt_usage(
    prompt_id: Any,
    prompt: Any,
    raw_source: Any = None,
    extra_data: Any = None,
    outputs_to_execute: Any = None,
) -> None:
    """Record model usage and custom packages on the validated output graph.

    Model identifiers retain their existing prompt-level behavior. Custom-node
    package attribution is stricter: it receives ComfyUI's validated output
    targets and only follows upstream input links from those targets. Successful
    non-cached per-node executions are still recorded separately.
    """
    if not isinstance(prompt_id, str) or not prompt_id.strip() or not isinstance(prompt, dict):
        return

    source, source_raw = infer_usage_source(raw_source, extra_data)
    try:
        try:
            from .custom_node_analytics import record_prompt_packages
        except ImportError:
            from custom_node_analytics import record_prompt_packages
        record_prompt_packages(prompt_id, prompt, source, outputs_to_execute=outputs_to_execute)
    except Exception:
        # Prompt/package analytics must never interrupt ComfyUI's execution
        # queue or prevent the established model usage tracker from running.
        log.exception("Model Analytics: failed to record custom-node packages in a started prompt")

    model_ids = sorted({_normalize_model_key(item) for item in iter_model_strings(prompt) if _normalize_model_key(item)})
    if not model_ids:
        return

    timestamp = datetime.now(timezone.utc).isoformat()
    prompt_id = prompt_id.strip()

    with _lock:
        database = _load_history()
        events = database.setdefault("usage_events", [])
        event = _usage_event_index.get(prompt_id)
        if event is None:
            event = {
                "prompt_id": prompt_id,
                "timestamp": timestamp,
                "source": source,
                "source_raw": source_raw,
                "models": model_ids,
            }
            events.append(event)
            _usage_event_index[prompt_id] = event
        else:
            existing = set(event.get("models", []))
            event["models"] = sorted(existing.union(model_ids))
            # Only an explicit source can improve an Unknown tag on this same
            # prompt id. Historical model counters are never modified.
            if event.get("source") == "unknown" and source != "unknown":
                event["source"] = source
                event["source_raw"] = source_raw
        _save_history()


def _install_prompt_queue_hook(quiet: bool = False) -> bool:
    """Observe prompts when ComfyUI's worker dequeues them for execution.

    ComfyUI 0.43.0 merges the ``Comfy-Usage-Source`` request header into
    ``extra_data`` before inserting the item into PromptQueue. PromptQueue.get
    returns that same item when a worker starts it, so this hook records
    actual starts rather than prompts that were merely submitted and may
    later be removed from the pending queue.
    """
    try:
        from server import PromptServer
        queue = PromptServer.instance.prompt_queue
    except Exception as e:
        if not quiet:
            log.warning("Model Analytics: prompt queue unavailable for source tracking: %s", e)
        return False

    if getattr(queue, "_model_analytics_usage_source_hook", False):
        return True

    original_get = getattr(queue, "get", None)
    if not callable(original_get):
        log.warning("Model Analytics: PromptQueue.get unavailable; source tracking disabled")
        return False

    def tracked_get(*args, **kwargs):
        result = original_get(*args, **kwargs)
        try:
            # ComfyUI 0.43.0 returns (queue_item, task_id). A timeout may
            # return None; do not record anything in that case.
            if isinstance(result, (tuple, list)) and len(result) >= 1:
                item = result[0]
                if isinstance(item, (tuple, list)) and len(item) >= 4:
                    prompt_id = item[1]
                    prompt = item[2]
                    extra_data = item[3] if isinstance(item[3], dict) else {}
                    # ComfyUI PromptQueue items are (number, prompt_id, prompt,
                    # extra_data, outputs_to_execute, sensitive). The fifth
                    # field contains validated execution targets; without it
                    # custom-package usage is deliberately not inferred.
                    outputs_to_execute = item[4] if len(item) >= 5 else None
                    record_prompt_usage(
                        prompt_id, prompt, extra_data.get("comfy_usage_source"),
                        extra_data, outputs_to_execute=outputs_to_execute,
                    )
        except Exception:
            # Analytics must never interrupt ComfyUI's execution worker.
            log.exception("Model Analytics: failed to record started prompt usage source")
        return result

    queue.get = tracked_get
    queue._model_analytics_usage_source_hook = True
    queue._model_analytics_original_get = original_get
    log.info("Model Analytics: prompt source tracking installed on PromptQueue.get")
    return True


def get_usage_database_snapshot() -> tuple[Dict[str, Any], list[Dict[str, Any]]]:
    """Return shallow snapshots from the unified model history database."""
    with _lock:
        database = _load_history()
        models = database.get("models", {})
        events = database.get("usage_events", [])
        return dict(models), [dict(item) for item in events if isinstance(item, dict)]


def build_usage_analytics(period: str = "all") -> Dict[str, Any]:
    """Aggregate prompt/model usage by source for the chosen time window.

    Legacy queue counters are Unknown only in all-time results. They have no
    trustworthy per-use timestamps, so shorter periods exclude them.
    """
    windows = {
        "24h": timedelta(hours=24),
        "5d": timedelta(days=5),
        "7d": timedelta(days=7),
        "30d": timedelta(days=30),
        "all": None,
    }
    duration = windows.get(period)
    if period not in windows:
        # The dashboard's recency control accepts any positive day count.
        # Support that same value for source filtering instead of silently
        # rounding it to one of the preset analytics periods.
        try:
            raw_days = str(period).strip().lower()
            if not raw_days.endswith("d"):
                raise ValueError("period must be a day count")
            days = float(raw_days[:-1])
            if not math.isfinite(days) or days <= 0 or days > 365000:
                raise ValueError("period day count out of range")
            duration = timedelta(days=days)
            period = f"{days:g}d"
        except (TypeError, ValueError, OverflowError):
            period = "all"
            duration = None
    now = datetime.now(timezone.utc)
    cutoff = now - duration if duration is not None else None
    legacy_models, events = get_usage_database_snapshot()

    source_stats = {source: {"executions": 0, "model_uses": 0} for source in USAGE_SOURCE_IDS}
    model_stats: Dict[str, Dict[str, Any]] = {}
    daily_stats: Dict[str, Dict[str, Any]] = {}
    included_events = 0
    legacy_unknown_uses = 0

    def ensure_model(model_id: str) -> Dict[str, Any]:
        return model_stats.setdefault(model_id, {
            "model_id": model_id,
            "total_uses": 0,
            "source_counts": {source: 0 for source in USAGE_SOURCE_IDS},
            "last_used": None,
            "last_source": None,
        })

    for event in events:
        timestamp = _parse_last_used(event.get("timestamp"))
        if cutoff is not None and (timestamp is None or timestamp < cutoff):
            continue
        source = event.get("source")
        if source not in USAGE_SOURCE_IDS:
            source, source_raw = classify_usage_source(event.get("source_raw"))
        else:
            source_raw = event.get("source_raw")
        model_ids = event.get("models", [])
        if not isinstance(model_ids, list):
            continue
        deduped_ids = sorted({_normalize_model_key(item) for item in model_ids if _normalize_model_key(item)})
        if not deduped_ids:
            continue

        included_events += 1
        source_stats[source]["executions"] += 1
        source_stats[source]["model_uses"] += len(deduped_ids)

        date_key = timestamp.astimezone(timezone.utc).date().isoformat() if timestamp else None
        if date_key:
            day = daily_stats.setdefault(date_key, {
                "date": date_key,
                "executions": 0,
                "model_uses": 0,
                "source_counts": {source_id: 0 for source_id in USAGE_SOURCE_IDS},
            })
            day["executions"] += 1
            day["model_uses"] += len(deduped_ids)
            day["source_counts"][source] += len(deduped_ids)

        for model_id in deduped_ids:
            stats = ensure_model(model_id)
            stats["total_uses"] += 1
            stats["source_counts"][source] += 1
            previous = _parse_last_used(stats["last_used"])
            if timestamp and (previous is None or timestamp > previous):
                stats["last_used"] = timestamp.isoformat()
                stats["last_source"] = source

    if period == "all":
        for model_id, entry in legacy_models.items():
            if not isinstance(entry, dict):
                continue
            try:
                legacy_count = max(0, int(entry.get("legacy_unknown_usage_count", 0) or 0))
            except (TypeError, ValueError, OverflowError):
                legacy_count = 0
            if legacy_count <= 0:
                continue
            legacy_unknown_uses += legacy_count
            source_stats["unknown"]["model_uses"] += legacy_count
            stats = ensure_model(model_id)
            stats["total_uses"] += legacy_count
            stats["source_counts"]["unknown"] += legacy_count
            legacy_last_used = latest_timestamp(entry.get("last_used"), entry.get("last_queued"))
            legacy_dt = _parse_last_used(legacy_last_used)
            current_dt = _parse_last_used(stats.get("last_used"))
            if legacy_dt and (current_dt is None or legacy_dt > current_dt):
                stats["last_used"] = legacy_dt.isoformat()
                stats["last_source"] = "unknown"

    total_model_uses = sum(item["model_uses"] for item in source_stats.values())
    return {
        "success": True,
        "period": period,
        "total_executions": included_events,
        "total_model_uses": total_model_uses,
        "legacy_unknown_uses": legacy_unknown_uses,
        "source_counts": source_stats,
        "daily": [daily_stats[key] for key in sorted(daily_stats)],
        "models": sorted(model_stats.values(), key=lambda item: (-item["total_uses"], item["model_id"].lower())),
        "legacy_unknown_has_timestamps": False,
    }

def _on_prompt(json_data):
    """ComfyUI on-prompt handler: record every model file named in the
    queued prompt, then hand the data back untouched."""
    try:
        prompt = json_data.get("prompt") if isinstance(json_data, dict) else None
        if isinstance(prompt, dict):
            record_models_queued(iter_model_strings(prompt))
    except Exception as e:
        log.debug("Queue tracking failed: %s", e)
    try:
        # The prompt queue may not exist yet while this package is imported
        # at ComfyUI startup. The first submitted prompt (from the web UI or
        # any external API client) is the latest safe moment to attach the
        # source tracking; the call is a no-op once the hook is installed.
        _install_prompt_queue_hook(quiet=True)
    except Exception as e:
        log.debug("Late prompt queue hook install failed: %s", e)
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
        database = _load_history()
        models = database.get("models", {})
        _migrate_history_entries(models)
        return dict(models)

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
        entry.setdefault("legacy_unknown_usage_count", 0)


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

    # PromptQueue.get observes the final extra_data after the server has
    # copied the Comfy-Usage-Source HTTP header into it, and only records a
    # prompt once an execution worker actually starts it.
    _install_prompt_queue_hook()
