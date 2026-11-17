"""Custom-node inventory and successful-execution analytics for ComfyUI.

The module deliberately keeps custom-node history in its own JSON database.
It does not reuse or migrate model_history.json. Inventory is derived from
ComfyUI's custom_nodes folder registry and active NODE_CLASS_MAPPINGS. Prompt
usage is limited to packages reachable from ComfyUI's validated output targets;
execution counts are stricter and require a successful, non-cached per-node
execution result. Saved-workflow references are a separate, best-effort signal.
"""

from __future__ import annotations

import atexit
import contextvars
import inspect
import json
import logging
import os
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

try:
    import folder_paths
except ImportError:  # Allows isolated unit tests outside ComfyUI.
    folder_paths = None

log = logging.getLogger("ModelAnalytics")
_lock = threading.RLock()
_database: Dict[str, Any] = {}
_loaded = False
_loaded_mtime: Optional[float] = None
_dirty = False
_flush_timer: Optional[threading.Timer] = None
_execution_registry_cache: Optional[dict[str, str]] = None
_execution_registry_lock = threading.Lock()
_execution_registry_signature: Optional[tuple] = None
_prompt_event_index: dict[str, dict] = {}
_execution_call_context: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar(
    "model_analytics_execution_call_context", default=None
)
_pending_execution_calls: dict[tuple[str, str], float] = {}
_pending_execution_calls_lock = threading.Lock()
_inventory_cache_lock = threading.RLock()
_inventory_cache: Optional[dict] = None
_inventory_cache_signature: Optional[tuple] = None
_inventory_cache_revision = 0
_inventory_cache_session = uuid.uuid4().hex[:12]

_SCHEMA_VERSION = 4
_USAGE_SOURCE_IDS = ("frontend", "api", "unknown")
_DEFAULT_SETTINGS = {
    "tracking_enabled": True,
    "scan_workflows": True,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _database_path() -> str:
    if folder_paths is not None:
        try:
            user_dir = folder_paths.get_user_directory()
            if user_dir:
                return str(Path(user_dir) / "custom_node_history.json")
        except Exception as error:
            log.debug("Could not resolve ComfyUI user directory for custom-node history: %s", error)
    return str(Path.cwd() / "custom_node_history.json")


def _default_database() -> Dict[str, Any]:
    return {
        "schema_version": _SCHEMA_VERSION,
        "settings": dict(_DEFAULT_SETTINGS),
        "tracking_started_at": None,
        "packages": {},
        "prompt_events": [],
    }


def _normalize_prompt_events(raw_events: Any) -> list[dict]:
    """Validate and deduplicate package events by ComfyUI prompt id.

    Only events explicitly scoped to the validated output graph are eligible
    for usage analytics. Older versions stored package presence for every node
    in a prompt, including disconnected/orphaned branches; those records are
    retained as ``unverified_legacy`` but are not counted as usage.
    """
    merged: dict[str, dict] = {}
    if not isinstance(raw_events, list):
        return []
    for raw_event in raw_events:
        if not isinstance(raw_event, dict):
            continue
        prompt_id = raw_event.get("prompt_id")
        if not isinstance(prompt_id, str) or not prompt_id.strip():
            continue
        prompt_id = prompt_id.strip()
        raw_source = raw_event.get("source")
        source = raw_source if raw_source in _USAGE_SOURCE_IDS else "unknown"
        timestamp = raw_event.get("timestamp")
        if not isinstance(timestamp, str) or not timestamp.strip():
            timestamp = None
        raw_packages = raw_event.get("packages", [])
        packages = sorted({
            item.strip() for item in raw_packages
            if isinstance(item, str) and item.strip()
        }) if isinstance(raw_packages, list) else []
        if not packages:
            continue
        scope = raw_event.get("scope")
        if scope != "active_output_graph":
            scope = "unverified_legacy"

        current = merged.get(prompt_id)
        if current is None:
            merged[prompt_id] = {
                "prompt_id": prompt_id,
                "timestamp": timestamp,
                "source": source,
                "packages": packages,
                "scope": scope,
            }
            continue

        # A newly verified observation supersedes the old whole-prompt list.
        # Verified observations may then be safely merged for the same prompt.
        if scope == "active_output_graph":
            if current["scope"] != "active_output_graph":
                current["packages"] = packages
                current["scope"] = scope
            else:
                current["packages"] = sorted(set(current["packages"]).union(packages))
        elif current["scope"] != "active_output_graph":
            current["packages"] = sorted(set(current["packages"]).union(packages))
        if current["source"] == "unknown" and source != "unknown":
            current["source"] = source
        if not current.get("timestamp") and timestamp:
            current["timestamp"] = timestamp
    return list(merged.values())


def _normalize_database(raw: Any) -> Dict[str, Any]:
    """Load package-level history and migrate earlier schemas in memory."""
    if not isinstance(raw, dict) or raw.get("schema_version") not in (1, 2, 3, _SCHEMA_VERSION):
        return _default_database()

    settings = dict(_DEFAULT_SETTINGS)
    loaded_settings = raw.get("settings")
    if isinstance(loaded_settings, dict):
        for key in settings:
            value = loaded_settings.get(key)
            if isinstance(value, bool):
                settings[key] = value

    package_history: dict[str, dict] = {}

    def add_history(package_id: Any, entry: Any) -> None:
        if not isinstance(package_id, str) or not package_id or not isinstance(entry, dict):
            return
        try:
            count = max(0, int(entry.get("execution_count", 0) or 0))
        except (TypeError, ValueError, OverflowError):
            count = 0
        existing = package_history.setdefault(package_id, {
            "execution_count": 0,
            "first_executed": None,
            "last_executed": None,
        })
        existing["execution_count"] += count
        first = entry.get("first_executed") if isinstance(entry.get("first_executed"), str) else None
        last = entry.get("last_executed") if isinstance(entry.get("last_executed"), str) else None
        if first and (existing["first_executed"] is None or first < existing["first_executed"]):
            existing["first_executed"] = first
        if last and (existing["last_executed"] is None or last > existing["last_executed"]):
            existing["last_executed"] = last

    if raw.get("schema_version") == 1:
        # Preserve all recorded historical counts, but collapse them to package
        # totals. This removes per-node history rows from future writes.
        old_nodes = raw.get("nodes")
        if isinstance(old_nodes, dict):
            for entry in old_nodes.values():
                if isinstance(entry, dict):
                    add_history(entry.get("package_id"), entry)
    else:
        stored_packages = raw.get("packages")
        if isinstance(stored_packages, dict):
            for package_id, entry in stored_packages.items():
                add_history(package_id, entry)

    started_at = raw.get("tracking_started_at")
    return {
        "schema_version": _SCHEMA_VERSION,
        "settings": settings,
        "tracking_started_at": started_at if isinstance(started_at, str) else None,
        "packages": package_history,
        "prompt_events": _normalize_prompt_events(raw.get("prompt_events", [])),
    }

def _load_database() -> Dict[str, Any]:
    global _database, _loaded, _loaded_mtime, _dirty, _inventory_cache, _inventory_cache_signature, _prompt_event_index
    path = _database_path()
    try:
        current_mtime = os.path.getmtime(path)
    except OSError:
        current_mtime = None
    if _loaded and current_mtime == _loaded_mtime:
        return _database

    raw: Any = {}
    if current_mtime is not None:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
            log.warning("Could not read custom_node_history.json; starting with an empty custom-node history: %s", error)
    was_loaded = _loaded
    previous_mtime = _loaded_mtime
    _database = _normalize_database(raw)
    _prompt_event_index = {
        event["prompt_id"]: event
        for event in _database.get("prompt_events", [])
        if isinstance(event, dict) and isinstance(event.get("prompt_id"), str)
    }
    if isinstance(raw, dict) and raw.get("schema_version") in (1, 2, 3):
        _dirty = True
    _loaded = True
    _loaded_mtime = current_mtime
    if was_loaded and current_mtime != previous_mtime:
        # An external edit/replacement of custom_node_history.json must not
        # leave package counters from an older in-memory inventory visible.
        _inventory_cache = None
        _inventory_cache_signature = None
    return _database


def _save_database() -> bool:
    global _loaded_mtime, _dirty, _flush_timer
    path = _database_path()
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        temporary_path = path + ".tmp"
        with open(temporary_path, "w", encoding="utf-8") as handle:
            json.dump(_database, handle, ensure_ascii=False, indent=2)
        os.replace(temporary_path, path)
        _dirty = False
        if _flush_timer is not None:
            _flush_timer.cancel()
            _flush_timer = None
        try:
            _loaded_mtime = os.path.getmtime(path)
        except OSError:
            _loaded_mtime = None
        return True
    except OSError as error:
        log.error("Could not persist custom_node_history.json: %s", error)
        return False


def _flush_deferred() -> None:
    global _flush_timer
    with _lock:
        _flush_timer = None
        if _dirty:
            _save_database()


def _schedule_deferred_save() -> None:
    global _flush_timer, _dirty
    _dirty = True
    if _flush_timer is None:
        _flush_timer = threading.Timer(1.0, _flush_deferred)
        _flush_timer.daemon = True
        _flush_timer.start()


def _flush_pending() -> None:
    with _lock:
        if _dirty:
            _save_database()


atexit.register(_flush_pending)


def get_settings() -> Dict[str, bool]:
    with _lock:
        database = _load_database()
        return dict(database["settings"])


def update_settings(values: Any) -> Dict[str, bool]:
    """Persist only the two explicitly supported boolean settings."""
    if not isinstance(values, dict):
        raise ValueError("Settings payload must be an object")
    with _lock:
        database = _load_database()
        settings = database["settings"]
        changed = False
        for key in _DEFAULT_SETTINGS:
            if key not in values:
                continue
            value = values[key]
            if not isinstance(value, bool):
                raise ValueError(f"{key} must be a boolean")
            if settings.get(key) != value:
                settings[key] = value
                changed = True
        if changed:
            if settings["tracking_enabled"] and not database.get("tracking_started_at"):
                database["tracking_started_at"] = _now()
            _save_database()
        return dict(settings)


def record_package_executed(package_id: str) -> None:
    """Record one successful execution attributed to an installed package."""
    if not package_id:
        return
    timestamp = _now()
    with _lock:
        database = _load_database()
        if not database["settings"].get("tracking_enabled", True):
            return
        if not database.get("tracking_started_at"):
            database["tracking_started_at"] = timestamp
        entry = database["packages"].get(package_id)
        if not isinstance(entry, dict):
            entry = {
                "execution_count": 0,
                "first_executed": timestamp,
                "last_executed": None,
            }
        entry["execution_count"] = max(0, int(entry.get("execution_count", 0) or 0)) + 1
        entry["first_executed"] = entry.get("first_executed") or timestamp
        entry["last_executed"] = timestamp
        database["packages"][package_id] = entry
        _schedule_deferred_save()
    _update_cached_package_execution(package_id, timestamp)


def _get_execution_registry_snapshot() -> dict[str, str]:
    """Return the class_type -> package map, rebuilding only when ComfyUI registrations change.

    ComfyUI can import this extension before all custom-node packages finish
    registering. An unavailable or still-empty registry must therefore not
    become a permanent empty cache. The cheap registry signature lets later
    prompt starts pick up newly registered nodes without rescanning packages
    for every node in every prompt.
    """
    global _execution_registry_cache, _execution_registry_signature

    comfy_nodes = _comfy_node_module()
    signature = _node_registry_signature(comfy_nodes)
    if _execution_registry_cache is not None and signature == _execution_registry_signature:
        return dict(_execution_registry_cache)
    if comfy_nodes is None:
        # Do not memoize the unavailable state; ComfyUI may not have imported
        # its node registry yet. Retry when a later prompt arrives.
        return dict(_execution_registry_cache or {})

    with _execution_registry_lock:
        comfy_nodes = _comfy_node_module()
        signature = _node_registry_signature(comfy_nodes)
        if _execution_registry_cache is None or signature != _execution_registry_signature:
            try:
                if comfy_nodes is None:
                    return dict(_execution_registry_cache or {})
                packages, _roots = _discover_packages()
                _execution_registry_cache = _registered_custom_nodes(packages, comfy_nodes)
                _execution_registry_signature = signature
            except Exception:
                log.exception("Could not build custom-node package registry for prompt analytics")
                # Keep the cache unset after a transient failure so the next
                # call can retry rather than preserving a false empty result.
                _execution_registry_cache = None
                _execution_registry_signature = None
                return {}
    return dict(_execution_registry_cache or {})


def _linked_prompt_node_ids(value: Any, prompt_node_ids: set[str]) -> Iterable[str]:
    """Yield node ids referenced by ComfyUI ``[node_id, output_index]`` links."""
    if not isinstance(value, (list, tuple)):
        return
    if (
        len(value) == 2
        and isinstance(value[0], (str, int))
        and not isinstance(value[0], bool)
        and str(value[0]) in prompt_node_ids
        and isinstance(value[1], int)
        and not isinstance(value[1], bool)
    ):
        yield str(value[0])
        return
    # Some nodes expose list-like inputs containing multiple links. Recurse
    # through containers, but only accept exact ComfyUI link pairs above.
    for item in value:
        yield from _linked_prompt_node_ids(item, prompt_node_ids)


def _active_prompt_node_ids(prompt: Any, outputs_to_execute: Any) -> set[str]:
    """Return nodes reachable upstream from ComfyUI's validated output targets.

    PromptQueue items contain ``outputs_to_execute`` as their fifth element.
    These are the valid output nodes the worker will execute. Walking only
    their upstream input links excludes connected-but-orphaned node chains
    that sit beside the workflow's actual requested outputs.
    """
    if not isinstance(prompt, dict) or not isinstance(outputs_to_execute, (list, tuple, set)):
        return set()

    prompt_by_id = {str(node_id): node for node_id, node in prompt.items() if isinstance(node, dict)}
    if not prompt_by_id:
        return set()

    pending = [str(node_id) for node_id in outputs_to_execute if str(node_id) in prompt_by_id]
    if not pending:
        return set()

    active: set[str] = set()
    while pending:
        node_id = pending.pop()
        if node_id in active:
            continue
        node = prompt_by_id.get(node_id)
        if not isinstance(node, dict):
            continue
        active.add(node_id)
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for input_value in inputs.values():
            for source_id in _linked_prompt_node_ids(input_value, prompt_by_id):
                if source_id not in active:
                    pending.append(source_id)
    return active


def record_prompt_packages(
    prompt_id: Any,
    prompt: Any,
    source: str = "unknown",
    timestamp: Optional[str] = None,
    outputs_to_execute: Any = None,
) -> None:
    """Record packages on the validated output graph of a started prompt.

    Only node classes reachable upstream from ComfyUI's ``outputs_to_execute``
    targets are considered. A merely connected but orphaned chain elsewhere in
    the prompt is excluded. This is graph participation, not proof that every
    reachable node ran: ``record_package_executed`` remains the stricter signal
    and counts only successful, non-cached per-node execution steps.
    """
    global _prompt_event_index
    if not isinstance(prompt_id, str) or not prompt_id.strip() or not isinstance(prompt, dict):
        return

    active_node_ids = _active_prompt_node_ids(prompt, outputs_to_execute)
    if not active_node_ids:
        return
    prompt_by_id = {str(node_id): node for node_id, node in prompt.items() if isinstance(node, dict)}
    class_ids = {
        prompt_by_id[node_id].get("class_type")
        for node_id in active_node_ids
        if isinstance(prompt_by_id.get(node_id, {}).get("class_type"), str)
    }
    if not class_ids:
        return

    source = source if source in _USAGE_SOURCE_IDS else "unknown"
    registry = _get_execution_registry_snapshot()
    package_ids = sorted({registry[class_id] for class_id in class_ids if class_id in registry})
    if not package_ids:
        return

    prompt_id = prompt_id.strip()
    timestamp = timestamp if isinstance(timestamp, str) and timestamp.strip() else _now()
    with _lock:
        database = _load_database()
        if not database["settings"].get("tracking_enabled", True):
            return
        if not database.get("tracking_started_at"):
            database["tracking_started_at"] = timestamp
        event = _prompt_event_index.get(prompt_id)
        if event is None:
            event = {
                "prompt_id": prompt_id,
                "timestamp": timestamp,
                "source": source,
                "packages": package_ids,
                "scope": "active_output_graph",
            }
            database.setdefault("prompt_events", []).append(event)
            _prompt_event_index[prompt_id] = event
        else:
            # If this prompt id was recorded by an older version without graph
            # scoping, replace its unverified package set with this verified one.
            if event.get("scope") != "active_output_graph":
                event["packages"] = package_ids
                event["scope"] = "active_output_graph"
            else:
                event["packages"] = sorted(set(event.get("packages", [])).union(package_ids))
            if event.get("source") == "unknown" and source != "unknown":
                event["source"] = source
            if not event.get("timestamp"):
                event["timestamp"] = timestamp
        _schedule_deferred_save()


def build_custom_node_usage_analytics(period: str = "all") -> Dict[str, Any]:
    """Aggregate active-output-graph package events by source and time window.

    ``execution_in_period`` is based only on the last successful, non-cached
    node execution timestamp. Source-specific graph attribution comes from
    PromptQueue output targets; unverified legacy prompt-presence events are
    retained on disk but excluded from the usage aggregates.
    """
    duration = None
    if period != "all":
        try:
            raw_days = str(period).strip().lower()
            if raw_days.endswith("d"):
                raw_days = raw_days[:-1]
            days = float(raw_days)
            if not (0 < days <= 365000):
                raise ValueError("period day count out of range")
            from datetime import timedelta
            duration = timedelta(days=days)
        except (TypeError, ValueError, OverflowError):
            period = "all"
            duration = None

    now = datetime.now(timezone.utc)
    cutoff = now - duration if duration is not None else None
    with _lock:
        database = _load_database()
        prompt_events = [dict(event) for event in database.get("prompt_events", []) if isinstance(event, dict)]
        package_history = {key: dict(value) for key, value in database.get("packages", {}).items() if isinstance(value, dict)}

    package_stats: dict[str, dict] = {}
    included_prompts = 0
    for event in prompt_events:
        # Pre-1.5.7 events have no output-graph proof and may include orphaned
        # chains. Keep them on disk for auditability but exclude them from the
        # Used/Unused and source/time analytics.
        if event.get("scope") != "active_output_graph":
            continue
        timestamp = event.get("timestamp")
        try:
            event_dt = datetime.fromisoformat(timestamp) if isinstance(timestamp, str) else None
            if event_dt is not None and event_dt.tzinfo is None:
                event_dt = event_dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            event_dt = None
        if cutoff is not None and (event_dt is None or event_dt < cutoff):
            continue
        source = event.get("source") if event.get("source") in _USAGE_SOURCE_IDS else "unknown"
        packages = event.get("packages", [])
        package_ids = sorted({item for item in packages if isinstance(item, str) and item}) if isinstance(packages, list) else []
        if not package_ids:
            continue
        included_prompts += 1
        for package_id in package_ids:
            stats = package_stats.setdefault(package_id, {
                "package_id": package_id,
                "prompt_count": 0,
                "source_counts": {item: 0 for item in _USAGE_SOURCE_IDS},
                "last_seen_in_prompt": None,
                "last_source": None,
                "execution_count": 0,
                "has_execution": False,
                "execution_in_period": False,
                "last_executed": None,
            })
            stats["prompt_count"] += 1
            stats["source_counts"][source] += 1
            last_seen = stats.get("last_seen_in_prompt")
            try:
                last_seen_dt = datetime.fromisoformat(last_seen) if last_seen else None
                if last_seen_dt is not None and last_seen_dt.tzinfo is None:
                    last_seen_dt = last_seen_dt.replace(tzinfo=timezone.utc)
            except (TypeError, ValueError):
                last_seen_dt = None
            if timestamp and (last_seen_dt is None or (event_dt and event_dt > last_seen_dt)):
                stats["last_seen_in_prompt"] = timestamp
                stats["last_source"] = source

    all_package_ids = set(package_stats).union(package_history)
    for package_id in all_package_ids:
        stats = package_stats.setdefault(package_id, {
            "package_id": package_id,
            "prompt_count": 0,
            "source_counts": {item: 0 for item in _USAGE_SOURCE_IDS},
            "last_seen_in_prompt": None,
            "last_source": None,
            "execution_count": 0,
            "has_execution": False,
            "execution_in_period": False,
            "last_executed": None,
        })
        history = package_history.get(package_id, {})
        try:
            execution_count = max(0, int(history.get("execution_count", 0) or 0))
        except (TypeError, ValueError, OverflowError):
            execution_count = 0
        last_executed = history.get("last_executed") if isinstance(history.get("last_executed"), str) else None
        try:
            last_execution_dt = datetime.fromisoformat(last_executed) if last_executed else None
            if last_execution_dt is not None and last_execution_dt.tzinfo is None:
                last_execution_dt = last_execution_dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            last_execution_dt = None
        stats["execution_count"] = execution_count
        stats["has_execution"] = execution_count > 0
        stats["last_executed"] = last_executed
        stats["execution_in_period"] = bool(
            execution_count > 0 and last_execution_dt is not None
            and (cutoff is None or last_execution_dt >= cutoff)
        )

    return {
        "period": period,
        "prompt_events": included_prompts,
        "custom_packages": sorted(package_stats.values(), key=lambda item: item["package_id"].casefold()),
        "source_counts": {
            source: sum(item["source_counts"].get(source, 0) for item in package_stats.values())
            for source in _USAGE_SOURCE_IDS
        },
    }


def record_node_executed(package_id: str, node_id: str, class_name: str = "", display_name: str = "") -> None:
    """Compatibility wrapper; execution history is stored at package level."""
    if package_id and node_id:
        record_package_executed(package_id)

def _safe_custom_roots() -> list[Path]:
    if folder_paths is None:
        return []
    try:
        roots = folder_paths.get_folder_paths("custom_nodes")
    except Exception as error:
        log.warning("Could not resolve ComfyUI custom-node directories: %s", error)
        return []
    result = []
    for raw_root in roots or []:
        try:
            root = Path(raw_root).resolve()
            if root.is_dir() and root not in result:
                result.append(root)
        except (OSError, TypeError, ValueError):
            continue
    return result


def _iter_package_entries(root: Path) -> Iterable[Path]:
    try:
        entries = sorted(root.iterdir(), key=lambda item: item.name.casefold())
    except OSError as error:
        log.debug("Could not list custom-node directory %s: %s", root.name, error)
        return
    for entry in entries:
        if entry.name == "__pycache__" or entry.name.startswith("."):
            continue
        if entry.name == "__init__.py":
            continue
        try:
            if entry.is_dir():
                yield entry
            elif entry.is_file() and (entry.suffix.lower() == ".py" or entry.name.lower().endswith(".disabled")):
                yield entry
        except OSError:
            continue


def _package_id(root_index: int, relative_path: str) -> str:
    # Root index avoids collisions when multiple custom_nodes directories
    # contain packages with the same folder name, without exposing full paths.
    return f"root{root_index}:{relative_path.replace(os.sep, '/')}"


def _discover_packages(roots: Optional[list[Path]] = None) -> tuple[list[dict], list[Path]]:
    packages = []
    roots = _safe_custom_roots() if roots is None else roots
    for root_index, root in enumerate(roots):
        for path in _iter_package_entries(root):
            try:
                relative = path.relative_to(root).as_posix()
                disabled = path.name.lower().endswith(".disabled")
                name = path.name[:-9] if disabled else path.stem if path.is_file() else path.name
                packages.append({
                    "id": _package_id(root_index, relative),
                    "name": name,
                    "relative_path": relative,
                    "root_index": root_index,
                    "absolute_path": path.resolve(),
                    "disabled": disabled,
                })
            except (OSError, ValueError):
                continue
    return packages, roots


def _path_is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except (OSError, ValueError):
        return False


def _class_module_path(node_class: Any) -> Optional[Path]:
    try:
        module = sys.modules.get(getattr(node_class, "__module__", ""))
        module_file = getattr(module, "__file__", None)
        if module_file:
            return Path(module_file).resolve()
    except (OSError, TypeError, ValueError):
        pass
    try:
        return Path(inspect.getfile(node_class)).resolve()
    except (OSError, TypeError, ValueError):
        return None


def _package_for_path(path_value: Any, packages: list[dict]) -> Optional[dict]:
    if not path_value:
        return None
    try:
        path = Path(path_value).resolve()
    except (OSError, TypeError, ValueError):
        return None
    matches = []
    for package in packages:
        package_path = package["absolute_path"]
        if package_path.is_dir() and _path_is_within(path, package_path):
            matches.append(package)
        elif package_path.is_file() and path == package_path:
            matches.append(package)
    if matches:
        return max(matches, key=lambda item: len(item["relative_path"]))
    return None


def _module_name_for_relative_module(relative_module: Any) -> Optional[str]:
    if not isinstance(relative_module, str) or not relative_module.startswith("custom_nodes."):
        return None
    # The suffix normally is one package folder name, but keep the full
    # suffix because legal package/module names can themselves contain dots.
    module_name = relative_module[len("custom_nodes."):].strip(".")
    return module_name or None


def _resolve_module_package(
    module_name: Optional[str],
    packages: list[dict],
    loaded_module_dirs: Optional[dict] = None,
    web_directory: Any = None,
) -> Optional[dict]:
    """Resolve a ComfyUI loader module name to its installed package.

    ComfyUI's loader stores the real import directory in LOADED_MODULE_DIRS.
    The module name is the fallback for single-file modules and older builds.
    """
    loaded_module_dirs = loaded_module_dirs if isinstance(loaded_module_dirs, dict) else {}
    if module_name:
        loaded_dir = loaded_module_dirs.get(module_name)
        package = _package_for_path(loaded_dir, packages)
        if package:
            return package

    package = _package_for_path(web_directory, packages)
    if package:
        return package

    if module_name:
        candidates = [
            item for item in packages
            if Path(item["relative_path"]).stem == module_name or item["name"] == module_name
        ]
        if len(candidates) == 1:
            return candidates[0]
    return None


def _resolve_package(
    node_class: Any,
    packages: list[dict],
    loaded_module_dirs: Optional[dict] = None,
) -> Optional[dict]:
    """Resolve a registered class through ComfyUI's owner metadata first.

    `RELATIVE_PYTHON_MODULE` is assigned by ComfyUI when it registers V1 and
    V3 nodes. It identifies the package which registered a class even when
    the class itself was imported/re-exported from a shared Python module.
    """
    relative_module = getattr(node_class, "RELATIVE_PYTHON_MODULE", "")
    module_name = _module_name_for_relative_module(relative_module)
    package = _resolve_module_package(module_name, packages, loaded_module_dirs)
    if package:
        return package

    # Some older forks or custom registrars do not set RELATIVE_PYTHON_MODULE.
    # In that case, use the Python source location as a conservative fallback.
    module_path = _class_module_path(node_class)
    package = _package_for_path(module_path, packages)
    if package:
        return package

    # Last-resort module-name matching is allowed only when it is unique.
    if not module_name:
        class_module = getattr(node_class, "__module__", "")
        module_name = class_module.rsplit(".", 1)[-1] if isinstance(class_module, str) else None
    return _resolve_module_package(module_name, packages, loaded_module_dirs)


def _comfy_node_module():
    try:
        import nodes as comfy_nodes
        return comfy_nodes
    except Exception as error:
        log.debug("ComfyUI node registry is not available yet: %s", error)
        return None


def _node_registry_signature(comfy_nodes: Any = None) -> tuple:
    """Cheap change fingerprint for active node and frontend registrations."""
    comfy_nodes = comfy_nodes or _comfy_node_module()
    if comfy_nodes is None:
        return ("nodes-module-unavailable",)
    mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {})
    if not isinstance(mappings, dict):
        mappings = {}
    node_items = tuple(sorted(
        (
            str(node_id),
            id(node_class),
            str(getattr(node_class, "RELATIVE_PYTHON_MODULE", "") or ""),
            str(getattr(node_class, "__module__", "") or ""),
        )
        for node_id, node_class in mappings.items()
    ))
    loaded = getattr(comfy_nodes, "LOADED_MODULE_DIRS", {})
    loaded_items = tuple(sorted((str(name), str(path)) for name, path in loaded.items())) if isinstance(loaded, dict) else ()
    web_dirs = getattr(comfy_nodes, "EXTENSION_WEB_DIRS", {})
    web_items = tuple(sorted((str(name), str(path)) for name, path in web_dirs.items())) if isinstance(web_dirs, dict) else ()
    return (node_items, loaded_items, web_items)


def _registered_custom_nodes(packages: list[dict], comfy_nodes: Any = None) -> dict[str, str]:
    """Return only the internal node-type -> external-package mapping.

    This registry map is needed for attribution, but it is never returned to
    the dashboard. The API exposes a single aggregate row per package.
    """
    comfy_nodes = comfy_nodes or _comfy_node_module()
    if comfy_nodes is None:
        return {}
    mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {})
    if not isinstance(mappings, dict):
        return {}

    loaded_module_dirs = getattr(comfy_nodes, "LOADED_MODULE_DIRS", {})
    node_packages: dict[str, str] = {}
    for raw_node_id, node_class in list(mappings.items()):
        try:
            package = _resolve_package(node_class, packages, loaded_module_dirs)
            if package is None:
                # Core ComfyUI nodes and classes outside installed custom_nodes
                # packages are intentionally excluded.
                continue
            node_packages[str(raw_node_id)] = package["id"]
        except Exception:
            log.exception("Skipping one custom-node registry entry: %r", raw_node_id)
            continue
    return node_packages


def _registered_ui_packages(packages: list[dict], comfy_nodes: Any = None) -> set[str]:
    """Resolve ComfyUI's registered frontend extensions to custom packages."""
    comfy_nodes = comfy_nodes or _comfy_node_module()
    if comfy_nodes is None:
        return set()
    extension_dirs = getattr(comfy_nodes, "EXTENSION_WEB_DIRS", {})
    loaded_module_dirs = getattr(comfy_nodes, "LOADED_MODULE_DIRS", {})
    if not isinstance(extension_dirs, dict):
        return set()
    package_ids: set[str] = set()
    for module_name, web_directory in extension_dirs.items():
        try:
            package = _resolve_module_package(str(module_name), packages, loaded_module_dirs, web_directory)
            if package:
                package_ids.add(package["id"])
        except Exception:
            log.exception("Skipping one frontend-extension registry entry: %r", module_name)
    return package_ids


def _package_roots_signature(roots: list[Path]) -> tuple:
    """Fingerprint top-level package entries without walking package contents."""
    result = []
    for root in roots:
        try:
            root_stat = root.stat()
            entries = []
            for entry in sorted(root.iterdir(), key=lambda item: item.name.casefold()):
                if entry.name == "__pycache__" or entry.name.startswith(".") or entry.name == "__init__.py":
                    continue
                try:
                    stat = entry.stat()
                    entries.append((entry.name, stat.st_mode, stat.st_size, stat.st_mtime_ns))
                except OSError:
                    entries.append((entry.name, "stat-unavailable"))
            result.append((str(root), root_stat.st_mtime_ns, tuple(entries)))
        except OSError:
            result.append((str(root), "unavailable"))
    return tuple(result)

def _workflow_directories() -> tuple[Path, list[Path]]:
    try:
        from . import scanner
    except ImportError:
        try:
            import scanner
        except ImportError:
            return Path(), []
    try:
        candidates = scanner._candidate_workflow_dirs()
        resolved = scanner._get_workflows_dir()
        return resolved, candidates
    except Exception as error:
        log.warning("Could not resolve saved workflow directories for custom-node analytics: %s", error)
        return Path(), []


def _workflow_class_ids(data: Any) -> set[str]:
    """Extract node ids from standard workflow JSON and API-format prompts."""
    found: set[str] = set()

    def add(value: Any) -> None:
        if isinstance(value, str) and value.strip():
            found.add(value.strip())

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            # Also accept a bare ComfyUI API prompt mapping (node id ->
            # {class_type, inputs}), not only the wrapped {"prompt": ...}
            # representation used by some saved exports.
            add(value.get("class_type"))
            nodes_value = value.get("nodes")
            if isinstance(nodes_value, list):
                for item in nodes_value:
                    if isinstance(item, dict):
                        add(item.get("type") or item.get("class_type"))
                        visit(item)
            elif isinstance(nodes_value, dict):
                for item in nodes_value.values():
                    if isinstance(item, dict):
                        add(item.get("class_type"))
                        visit(item)

            prompt_value = value.get("prompt")
            if isinstance(prompt_value, dict):
                for item in prompt_value.values():
                    if isinstance(item, dict):
                        add(item.get("class_type"))
                        visit(item)

            # Nested groups/subgraphs can contain their own node arrays.
            for key, child in value.items():
                if key not in ("nodes", "prompt") and isinstance(child, (dict, list)):
                    visit(child)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    try:
        visit(data)
    except RecursionError:
        log.warning("A saved workflow is nested too deeply; only its readable node references were considered")
    return found


def _workflow_scan_snapshot(enabled: bool = True) -> dict:
    """List workflow files and fingerprint their metadata for change-only scans.

    The directory tree is enumerated to notice added/removed files, but JSON
    contents are only opened when this fingerprint changes.
    """
    if not enabled:
        return {
            "enabled": False,
            "available": False,
            "resolved": Path(),
            "candidates": [],
            "files": [],
            "signature": ("disabled",),
        }

    resolved, candidates = _workflow_directories()
    try:
        available = bool(candidates) and resolved != Path() and resolved.is_dir()
    except OSError:
        available = False
    if not available:
        candidate_names = tuple(str(path) for path in candidates)
        return {
            "enabled": True,
            "available": False,
            "resolved": Path(),
            "candidates": candidates,
            "files": [],
            "signature": ("unavailable", candidate_names),
        }

    try:
        from . import scanner
    except ImportError:
        import scanner

    files = []
    signature = []
    try:
        for relative_name, full_path in scanner._iter_workflow_files(resolved):
            files.append((relative_name, full_path))
            try:
                stat = full_path.stat()
                signature.append((relative_name, stat.st_mtime_ns, stat.st_size))
            except OSError:
                signature.append((relative_name, "stat-unavailable"))
    except Exception:
        log.exception("Could not enumerate saved workflows for custom-node analytics")
        signature.append(("enumeration-error",))

    signature.sort(key=lambda item: str(item[0]).casefold())
    return {
        "enabled": True,
        "available": True,
        "resolved": resolved,
        "candidates": candidates,
        "files": files,
        "signature": ("available", str(resolved), tuple(signature)),
    }


def _scan_workflow_references(
    node_packages: dict[str, str],
    package_names: Optional[dict[str, str]] = None,
    scan_snapshot: Optional[dict] = None,
) -> tuple[dict[str, list[str]], list[dict], dict]:
    """Scan saved workflows and aggregate matched external packages only."""
    package_workflows: dict[str, set[str]] = {}
    workflow_packages: dict[str, set[str]] = {}
    workflow_node_types: dict[str, set[str]] = {}
    scan_snapshot = scan_snapshot or _workflow_scan_snapshot(True)
    resolved = scan_snapshot.get("resolved", Path())
    candidates = scan_snapshot.get("candidates", [])
    if not scan_snapshot.get("available"):
        return {}, [], {
            "enabled": bool(scan_snapshot.get("enabled", True)),
            "available": False,
            "resolved_dir": None,
            "candidate_dirs": [path.name for path in candidates],
            "workflow_count": 0,
            "skipped_workflows": 0,
        }

    workflow_count = 0
    skipped = 0
    for relative_name, full_path in scan_snapshot.get("files", []):
        try:
            with full_path.open("r", encoding="utf-8") as handle:
                workflow = json.load(handle)
            workflow_count += 1
            matched_node_ids = _workflow_class_ids(workflow).intersection(node_packages)
            matched_packages = {node_packages[node_id] for node_id in matched_node_ids}
            if not matched_packages:
                continue
            workflow_packages[relative_name] = matched_packages
            workflow_node_types[relative_name] = matched_node_ids
            for package_id in matched_packages:
                package_workflows.setdefault(package_id, set()).add(relative_name)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
            skipped += 1
            log.debug("Skipping unreadable workflow %s: %s", relative_name, error)
        except Exception:
            skipped += 1
            log.exception("Skipping one workflow while scanning custom-node references: %s", relative_name)

    package_names = package_names or {}

    workflow_rows = [
        {
            "name": name,
            "package_count": len(package_ids),
            "node_type_count": len(workflow_node_types.get(name, set())),
            "package_names": sorted(package_names.get(package_id, package_id) for package_id in package_ids),
            "package_names_text": ", ".join(sorted(package_names.get(package_id, package_id) for package_id in package_ids)),
        }
        for name, package_ids in sorted(workflow_packages.items(), key=lambda item: item[0].casefold())
    ]
    return (
        {package_id: sorted(names) for package_id, names in package_workflows.items()},
        workflow_rows,
        {
            "enabled": True,
            "available": True,
            "resolved_dir": resolved.name or str(resolved),
            "candidate_dirs": [path.name for path in candidates],
            "workflow_count": workflow_count,
            "matched_workflow_count": len(workflow_rows),
            "skipped_workflows": skipped,
        },
    )

def _empty_workflow_info(enabled: bool) -> dict:
    return {
        "enabled": enabled,
        "available": False,
        "resolved_dir": None,
        "candidate_dirs": [],
        "workflow_count": 0,
        "skipped_workflows": 0,
    }


def _update_cached_package_execution(package_id: str, timestamp: str) -> None:
    """Apply a new execution to an existing in-memory snapshot without rescans."""
    global _inventory_cache_revision
    with _inventory_cache_lock:
        if not isinstance(_inventory_cache, dict):
            return
        row = next((item for item in _inventory_cache.get("packages", []) if item.get("id") == package_id), None)
        if row is None:
            # The registry may have changed since the last inventory request.
            global _inventory_cache_signature
            _inventory_cache_signature = None
            return
        previous_count = max(0, int(row.get("execution_count", 0) or 0))
        row["execution_count"] = previous_count + 1
        row["first_executed"] = row.get("first_executed") or timestamp
        row["last_executed"] = timestamp
        summary = _inventory_cache.setdefault("summary", {})
        summary["total_executions"] = int(summary.get("total_executions", 0) or 0) + 1
        if previous_count == 0 and not row.get("disabled"):
            summary["used_package_count"] = int(summary.get("used_package_count", 0) or 0) + 1
            summary["unused_package_count"] = max(0, int(summary.get("unused_package_count", 0) or 0) - 1)
        if not _inventory_cache.get("tracking_started_at"):
            _inventory_cache["tracking_started_at"] = timestamp
        _inventory_cache_revision += 1
        _inventory_cache["revision"] = f"{_inventory_cache_session}-{_inventory_cache_revision}"


def build_custom_node_inventory() -> Dict[str, Any]:
    """Return a cached package-level snapshot and rescan only changed inputs."""
    global _inventory_cache, _inventory_cache_signature
    global _execution_registry_cache, _execution_registry_signature
    global _inventory_cache_revision

    with _inventory_cache_lock:
        with _lock:
            database = _load_database()
            settings = dict(database["settings"])
            history = {key: dict(value) for key, value in database["packages"].items()}
            tracking_started_at = database.get("tracking_started_at")

        roots = _safe_custom_roots()
        package_signature = _package_roots_signature(roots)
        comfy_nodes = _comfy_node_module()
        registry_signature = _node_registry_signature(comfy_nodes)
        workflow_snapshot = _workflow_scan_snapshot(settings.get("scan_workflows", True))
        cache_signature = (
            package_signature,
            registry_signature,
            workflow_snapshot["signature"],
            tuple(sorted(settings.items())),
        )

        if _inventory_cache is not None and cache_signature == _inventory_cache_signature:
            return _inventory_cache

        packages, _roots = _discover_packages(roots)
        node_packages = _registered_custom_nodes(packages, comfy_nodes)
        ui_package_ids = _registered_ui_packages(packages, comfy_nodes)
        _execution_registry_cache = node_packages
        _execution_registry_signature = registry_signature

        registered_counts: dict[str, int] = {}
        for package_id in node_packages.values():
            registered_counts[package_id] = registered_counts.get(package_id, 0) + 1

        package_workflows: dict[str, list[str]] = {}
        workflow_rows: list[dict] = []
        workflow_info = _empty_workflow_info(False)
        if settings.get("scan_workflows", True):
            package_names = {item["id"]: item["name"] for item in packages}
            package_workflows, workflow_rows, workflow_info = _scan_workflow_references(
                node_packages, package_names, workflow_snapshot
            )

        package_rows = []
        for package in packages:
            package_id = package["id"]
            usage = history.get(package_id, {})
            execution_count = max(0, int(usage.get("execution_count", 0) or 0))
            workflow_names = package_workflows.get(package_id, [])
            registered_node_count = registered_counts.get(package_id, 0)
            has_nodes = registered_node_count > 0
            has_ui = package_id in ui_package_ids
            disabled = bool(package["disabled"])
            if has_nodes and has_ui:
                extension_type = "both"
            elif has_nodes:
                extension_type = "node_package"
            elif has_ui:
                extension_type = "ui_only"
            else:
                extension_type = "other"
            loaded = has_nodes or has_ui
            row = {
                "id": package_id,
                "name": package["name"],
                "relative_path": package["relative_path"],
                "disabled": disabled,
                "loaded": loaded,
                "has_node_classes": has_nodes,
                "ui_extension_registered": has_ui,
                "extension_type": extension_type,
                "registered_node_count": registered_node_count,
                "execution_count": execution_count,
                "workflow_count": len(workflow_names),
                "workflows": workflow_names,
                "first_executed": usage.get("first_executed"),
                "last_executed": usage.get("last_executed"),
                "status": "disabled" if disabled else "registered" if loaded else "not_registered",
            }
            package_rows.append(row)

        package_rows.sort(key=lambda item: item["name"].casefold())
        workflow_rows = [row for row in workflow_rows if row["package_count"] > 0]
        active_rows = [row for row in package_rows if not row["disabled"] and row["extension_type"] != "ui_only"]
        used_package_count = sum(1 for row in active_rows if row["execution_count"] > 0)
        unused_package_count = sum(1 for row in active_rows if row["execution_count"] == 0)
        disabled_package_count = sum(1 for row in package_rows if row["disabled"])
        total_executions = sum(row["execution_count"] for row in package_rows)
        _inventory_cache_revision += 1
        _inventory_cache = {
            "success": True,
            "revision": f"{_inventory_cache_session}-{_inventory_cache_revision}",
            "packages": package_rows,
            "workflows": workflow_rows,
            "summary": {
                "package_count": len(package_rows),
                "used_package_count": used_package_count,
                "unused_package_count": unused_package_count,
                "disabled_package_count": disabled_package_count,
                "registered_package_count": sum(1 for row in package_rows if row["loaded"]),
                "node_package_count": sum(1 for row in package_rows if row["has_node_classes"]),
                "ui_only_package_count": sum(1 for row in package_rows if row["extension_type"] == "ui_only"),
                "workflow_count": len(workflow_rows),
                "total_workflows_scanned": int(workflow_info.get("workflow_count", 0) or 0),
                "total_executions": total_executions,
            },
            "settings": settings,
            "tracking_started_at": tracking_started_at,
            "workflow_scan": workflow_info,
            "execution_tracking_available": getattr(build_custom_node_inventory, "hook_installed", False),
            "limitations": ["history", "execution", "workflow", "attribution"],
        }
        _inventory_cache_signature = cache_signature
        return _inventory_cache

def _resolve_execution_node(node_id: Any, dynamic_prompt: Any) -> Optional[str]:
    """Resolve a scheduled node id to its external package using a cached map."""
    global _execution_registry_cache
    if not isinstance(node_id, (str, int)) or dynamic_prompt is None:
        return None
    try:
        node_data = dynamic_prompt.get_node(node_id)
    except Exception:
        try:
            node_data = dynamic_prompt.get_node(str(node_id))
        except Exception:
            return None
    if not isinstance(node_data, dict):
        return None
    node_type = node_data.get("class_type")
    if not isinstance(node_type, str) or not node_type:
        return None

    return _get_execution_registry_snapshot().get(node_type)

def install_execution_hook() -> bool:
    """Count only custom-node functions that actually run and then succeed.

    ComfyUI can return SUCCESS for a cache hit and for a node whose lazy inputs
    block its function from being called. The output cache and ComfyUI's
    ``pre_execute_cb`` are therefore both observed: the callback is invoked
    immediately before a node FUNCTION runs. A pending callback is retained
    until ComfyUI completes an asynchronous or expanded subgraph execution.
    The wrapper is fail-open and never changes generation behavior.
    """
    try:
        import execution as comfy_execution
    except Exception as error:
        log.warning("Custom Node Analytics: ComfyUI execution module unavailable; execution tracking disabled: %s", error)
        return False

    if getattr(comfy_execution, "_custom_node_analytics_hook", False):
        build_custom_node_inventory.hook_installed = True
        return True

    original_execute = getattr(comfy_execution, "execute", None)
    original_get_output_data = getattr(comfy_execution, "get_output_data", None)
    if not callable(original_execute) or not inspect.iscoroutinefunction(original_execute):
        log.warning("Custom Node Analytics: async per-node execution entry point unavailable; execution tracking disabled")
        return False
    if not callable(original_get_output_data) or not inspect.iscoroutinefunction(original_get_output_data):
        log.warning("Custom Node Analytics: pre-execution callback unavailable; accurate function-invocation tracking disabled")
        return False

    async def tracked_get_output_data(*args, **kwargs):
        call_state = _execution_call_context.get()
        callback = kwargs.get("pre_execute_cb")
        callback_in_args = len(args) > 5
        if callback_in_args:
            callback = args[5]

        if call_state is not None and callable(callback):
            def mark_function_invoked(*callback_args, **callback_kwargs):
                call_state["function_invoked"] = True
                return callback(*callback_args, **callback_kwargs)

            if callback_in_args:
                mutable_args = list(args)
                mutable_args[5] = mark_function_invoked
                args = tuple(mutable_args)
            else:
                kwargs = dict(kwargs)
                kwargs["pre_execute_cb"] = mark_function_invoked

        return await original_get_output_data(*args, **kwargs)

    async def tracked_execute(*args, **kwargs):
        # ComfyUI returns SUCCESS for cache hits. Inspect the same output cache
        # before calling the original function so these do not inflate usage.
        dynamic_prompt = args[1] if len(args) > 1 else kwargs.get("dynprompt")
        caches = args[2] if len(args) > 2 else kwargs.get("caches")
        node_id = args[3] if len(args) > 3 else kwargs.get(
            "current_item", kwargs.get("node_id", kwargs.get("unique_id"))
        )
        prompt_id = args[6] if len(args) > 6 else kwargs.get("prompt_id")
        cache_miss_confirmed = False
        try:
            output_cache = getattr(caches, "outputs", None)
            cache_get = getattr(output_cache, "get", None)
            if callable(cache_get) and node_id is not None:
                cached_output = cache_get(node_id)
                if inspect.isawaitable(cached_output):
                    cached_output = await cached_output
                cache_miss_confirmed = cached_output is None
        except Exception:
            # Unknown cache state means we skip this sample instead of claiming
            # a newly executed node.
            log.debug("Custom Node Analytics: output-cache state unavailable for node %s", node_id, exc_info=True)

        call_state = {"function_invoked": False}
        context_token = _execution_call_context.set(call_state)
        try:
            result = await original_execute(*args, **kwargs)
        finally:
            _execution_call_context.reset(context_token)

        try:
            execution_result = result[0] if isinstance(result, (tuple, list)) and result else None
            result_enum = getattr(comfy_execution, "ExecutionResult", None)
            success_value = getattr(result_enum, "SUCCESS", None)
            pending_value = getattr(result_enum, "PENDING", None)
            failure_value = getattr(result_enum, "FAILURE", None)
            succeeded = execution_result == success_value if success_value is not None else getattr(execution_result, "name", None) == "SUCCESS"
            pending = pending_value is not None and execution_result == pending_value
            failed = failure_value is not None and execution_result == failure_value
            execution_key = (str(prompt_id or ""), str(node_id or ""))
            was_pending = False

            with _pending_execution_calls_lock:
                now = time.monotonic()
                # Interrupted/abandoned asynchronous work must not leave a
                # permanent in-memory entry. Expire pending markers after one hour.
                expired = [key for key, created in _pending_execution_calls.items() if now - created > 3600]
                for key in expired:
                    _pending_execution_calls.pop(key, None)
                if execution_key not in _pending_execution_calls and len(_pending_execution_calls) >= 4096:
                    oldest = sorted(_pending_execution_calls.items(), key=lambda item: item[1])[:512]
                    for key, _created in oldest:
                        _pending_execution_calls.pop(key, None)
                was_pending = execution_key in _pending_execution_calls

                if pending:
                    if call_state["function_invoked"] and prompt_id is not None and node_id is not None:
                        _pending_execution_calls[execution_key] = now
                elif succeeded:
                    _pending_execution_calls.pop(execution_key, None)
                elif failed:
                    _pending_execution_calls.pop(execution_key, None)

            function_completed = call_state["function_invoked"] or was_pending
            cache_proof = cache_miss_confirmed or was_pending
            if succeeded and function_completed and cache_proof:
                package_id = _resolve_execution_node(node_id, dynamic_prompt)
                if package_id:
                    record_package_executed(package_id)
        except Exception:
            # An analytics failure must never change ComfyUI generation.
            log.exception("Custom Node Analytics: could not record a completed node execution")
        return result

    tracked_execute.__name__ = getattr(original_execute, "__name__", "execute")
    tracked_execute.__doc__ = getattr(original_execute, "__doc__", None)
    tracked_execute.__wrapped__ = original_execute
    tracked_get_output_data.__name__ = getattr(original_get_output_data, "__name__", "get_output_data")
    tracked_get_output_data.__doc__ = getattr(original_get_output_data, "__doc__", None)
    tracked_get_output_data.__wrapped__ = original_get_output_data

    comfy_execution.get_output_data = tracked_get_output_data
    comfy_execution.execute = tracked_execute
    comfy_execution._custom_node_analytics_hook = True
    comfy_execution._custom_node_analytics_original_execute = original_execute
    comfy_execution._custom_node_analytics_original_get_output_data = original_get_output_data
    build_custom_node_inventory.hook_installed = True
    log.info("Custom Node Analytics: output-path and actual node-function execution tracking hooks installed")
    return True


build_custom_node_inventory.hook_installed = False

__all__ = [
    "build_custom_node_inventory",
    "build_custom_node_usage_analytics",
    "get_settings",
    "install_execution_hook",
    "record_prompt_packages",
    "record_node_executed",
    "record_package_executed",
    "update_settings",
]
