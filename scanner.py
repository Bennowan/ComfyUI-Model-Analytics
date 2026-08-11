"""
scanner.py
Read-only inventory logic:
  - Physical inventory: walks all folder_paths model directories on disk.
  - Logical inventory:   parses saved workflow JSON files and pulls out any
                          string value that looks like a model filename.

Scope: this scans ONLY directories that ComfyUI's folder_paths module
knows about as model directories (i.e. everything under the configured
models/ locations, including extra_model_paths.yaml entries). It never
walks custom_nodes/ or any other part of the ComfyUI installation.

Everything here is pure read/analysis - nothing is deleted or moved.

Portability notes:
  - All model directories are resolved exclusively through ComfyUI's
    `folder_paths` module (never hardcoded / relative paths), so this
    respects the user's extra_model_paths.yaml and works identically on
    Windows, Linux and macOS.
  - Paths are built and joined with pathlib.Path instead of string
    concatenation, so this works regardless of the OS path separator.
  - Extension matching is always done case-insensitively, since Linux
    filesystems are case-sensitive while Windows/macOS typically aren't.
"""

import re
import json
import logging
from pathlib import Path
from typing import Dict, List, Any

try:
    import folder_paths
except ImportError:  # allows the module to be imported/tested outside ComfyUI
    folder_paths = None

log = logging.getLogger("ModelAnalytics")

MODEL_EXTENSIONS = (".safetensors", ".ckpt", ".gguf", ".pt")

# ComfyUI (and users manually) mark a model as disabled by appending
# ".disabled" after the real extension, e.g. "model.safetensors.disabled".
# These should never be mixed into the active/unused classification - they
# get their own bucket entirely.
DISABLED_SUFFIX = ".disabled"

# Matches filenames whose "name" part (before the extension) is just a raw
# hash / id, e.g. HuggingFace cache blobs like
# "a1b2c3d4e5f6...safetensors" or plain numeric ids like "1234567.pt".
# These are internal cache/config artifacts, not real model files, and
# should not show up in the dashboard.
_HASH_OR_NUMERIC_STEM_RE = re.compile(r"^[0-9a-fA-F]{16,}$|^\d+$")


def _classify_model_file(filename: str):
    """
    Determine whether a filename is a real model file (optionally disabled),
    and if so, return {"disabled": bool, "stem": str}. Returns None if the
    filename doesn't match a known model extension at all (with or without
    a trailing ".disabled").
    """
    name = filename
    disabled = False
    if name.lower().endswith(DISABLED_SUFFIX):
        name = name[: -len(DISABLED_SUFFIX)]
        disabled = True

    lower = name.lower()
    for ext in MODEL_EXTENSIONS:
        if lower.endswith(ext):
            stem = name[: -len(ext)]
            return {"disabled": disabled, "stem": stem}
    return None


def _looks_like_real_model_file(stem: str) -> bool:
    """True for genuine model files, False for hash/id-named cache
    artifacts that merely happen to carry a model-like extension."""
    return not _HASH_OR_NUMERIC_STEM_RE.match(stem)


def _get_base_models_dir() -> Path:
    """The single canonical ComfyUI models/ root. Every directory we scan
    must resolve to be inside this tree - this is the enforcement point
    for 'models directory only'."""
    if folder_paths is None:
        return Path()
    base = getattr(folder_paths, "models_dir", None)
    if not base:
        # Very old ComfyUI versions may not expose models_dir directly;
        # fall back to deriving it from the base_path.
        base_path = getattr(folder_paths, "base_path", None)
        if base_path:
            base = str(Path(base_path) / "models")
    return Path(base).resolve() if base else Path()


# Path segments that must never be treated as part of the official models
# directory, even if some custom node registers a folder_paths entry
# pointing into them (a known pattern for nodes that bundle their own
# model-like assets, e.g. comfyui-web-viewer's music2emotion or
# ComfyUI-WanVideoWrapper's multitalk folder).
_EXCLUDED_PATH_SEGMENTS = {"custom_nodes", ".disabled"}


def _is_excluded_path(path: Path) -> bool:
    """True if any component of the path is a known non-model-directory
    segment (custom_nodes, .disabled, etc.) - checked defensively at the
    individual-file level, not just at the root-directory level, so a
    custom node can't sneak assets in via a symlink or a registered path
    that only partially overlaps the real models/ tree."""
    parts = {p.lower() for p in path.parts}
    return bool(parts & _EXCLUDED_PATH_SEGMENTS)


# Public alias so other modules (tracker.py) can reuse the exact same
# exclusion rule instead of re-implementing it and risking drift.
is_excluded_scan_path = _is_excluded_path


def _get_model_root_dirs() -> Dict[str, List[Path]]:
    """Ask ComfyUI's folder_paths for every known model directory kind,
    then keep only the ones that actually live inside the real models/
    root. This matters because custom nodes are able to register their
    own entries into folder_paths.folder_names_and_paths at runtime
    (e.g. via folder_paths.add_model_folder_path) to get their bundled
    assets recognized in ComfyUI's model dropdowns. Those directories are
    not part of the official models/ hierarchy and must never be scanned
    or shown in this dashboard, even though folder_paths itself makes no
    distinction between 'official' and 'custom-node-registered' entries."""
    roots: Dict[str, List[Path]] = {}
    if folder_paths is None:
        return roots

    base_models_dir = _get_base_models_dir()

    known_keys = list(getattr(folder_paths, "folder_names_and_paths", {}).keys())
    for key in known_keys:
        try:
            dirs = folder_paths.get_folder_paths(key)
        except Exception as e:
            log.warning("Could not resolve folder_paths kind '%s': %s", key, e)
            continue
        kept_dirs = []
        for d in dirs:
            resolved = Path(d).resolve()
            if _is_excluded_path(resolved):
                log.debug("Skipping non-model directory (excluded segment) for kind '%s': %s", key, resolved)
                continue
            if base_models_dir != Path() and base_models_dir not in resolved.parents and resolved != base_models_dir:
                log.debug("Skipping directory outside official models/ root for kind '%s': %s", key, resolved)
                continue
            kept_dirs.append(Path(d))
        if kept_dirs:
            roots[key] = kept_dirs
    return roots


def scan_disk_models() -> List[Dict[str, Any]]:
    """
    Physical inventory: walks every known model directory and returns
    a flat list of {kind, rel_path, abs_path, size_bytes}.

    rel_path is relative to its own model-kind root, and preserves nested
    subfolders (e.g. "chatterbox/chatterbox_multilingual/s3gen.pt") so that
    same-named files in different subfolders are never conflated.
    """
    results: List[Dict[str, Any]] = []
    roots = _get_model_root_dirs()

    # Some ComfyUI versions register more than one "kind" (e.g. both "unet"
    # and "diffusion_models") pointing at the very same physical directory.
    # Track resolved real paths we've already listed so the same file never
    # shows up twice in the dashboard.
    seen_real_paths = set()

    for kind, dirs in roots.items():
        for root_dir in dirs:
            if not root_dir.is_dir():
                continue
            for path in root_dir.rglob("*"):
                if not path.is_file():
                    continue

                classification = _classify_model_file(path.name)
                if classification is None:
                    continue
                if not _looks_like_real_model_file(classification["stem"]):
                    # Cache/config artifact (hash- or id-named file),
                    # not an actual model - skip it.
                    continue

                try:
                    real_path = path.resolve()
                except OSError:
                    real_path = path

                # Defense-in-depth: even though _get_model_root_dirs()
                # already filtered out custom_nodes/.disabled roots, catch
                # any file whose *resolved* path (following symlinks)
                # lands back inside one of those excluded trees.
                if _is_excluded_path(real_path):
                    log.debug("Skipping file inside excluded directory: %s", real_path)
                    continue

                if real_path in seen_real_paths:
                    continue
                seen_real_paths.add(real_path)

                rel_path = path.relative_to(root_dir).as_posix()
                try:
                    size_bytes = path.stat().st_size
                except OSError as e:
                    log.warning("Could not stat %s: %s", path, e)
                    size_bytes = 0
                results.append({
                    "kind": kind,
                    "rel_path": rel_path,
                    "abs_path": str(path),
                    "size_bytes": size_bytes,
                    "disabled": classification["disabled"],
                })

    return results


def _candidate_workflow_dirs() -> List[Path]:
    """All plausible locations for saved workflow JSON files, in priority
    order. Different ComfyUI versions / single- vs multi-user setups store
    these in slightly different places, so we check several and pick
    whichever one actually has files in it."""
    if folder_paths is None:
        return []
    try:
        user_dir = Path(folder_paths.get_user_directory())
    except Exception as e:
        log.warning("Could not resolve user directory: %s", e)
        return []

    return [
        user_dir / "default" / "workflows",  # current multi-user default
        user_dir / "workflows",              # older / single-user layout
    ]


def _count_json_files(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    return sum(1 for p in directory.rglob("*.json") if p.is_file())


def _get_workflows_dir() -> Path:
    """Pick the candidate workflow directory that actually contains
    saved workflow JSON files. Falls back to the first candidate (even if
    empty) so callers always get a consistent path to work with."""
    candidates = _candidate_workflow_dirs()
    if not candidates:
        return Path()

    best = max(candidates, key=_count_json_files, default=candidates[0])
    if _count_json_files(best) == 0:
        # Nothing found in any candidate - still return the modern default
        # so downstream code has a sensible (if empty) path to report.
        return candidates[0]
    return best


def _iter_model_strings(obj: Any):
    """Recursively yield every string value in a JSON structure that looks
    like a model filename, regardless of which key/node it's nested under."""
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _iter_model_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _iter_model_strings(v)
    elif isinstance(obj, str):
        if obj.lower().endswith(MODEL_EXTENSIONS):
            yield obj


def _iter_workflow_files(workflows_dir: Path):
    """Yield (relative_name, absolute_path) for every workflow JSON file,
    recursing into subfolders (users can organize workflows into folders
    in the ComfyUI UI)."""
    if not workflows_dir.is_dir():
        return
    for path in workflows_dir.rglob("*.json"):
        if path.is_file():
            yield path.relative_to(workflows_dir).as_posix(), path


def scan_workflows() -> Dict[str, List[str]]:
    """
    Logical inventory: maps a model filename (as it appears in the
    workflow JSON, e.g. "unet/Wan2.2-I2V.gguf" or just "model.safetensors")
    to the list of workflow filenames that reference it.
    """
    mapping: Dict[str, List[str]] = {}
    workflows_dir = _get_workflows_dir()

    for rel_name, full_path in _iter_workflow_files(workflows_dir):
        try:
            with full_path.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            log.warning("Skipping unreadable workflow %s: %s", rel_name, e)
            continue

        for model_str in _iter_model_strings(data):
            # Normalize slashes so "unet\\foo.gguf" and "unet/foo.gguf" match.
            normalized = model_str.replace("\\", "/")
            mapping.setdefault(normalized, [])
            if rel_name not in mapping[normalized]:
                mapping[normalized].append(rel_name)

    return mapping


def list_workflow_names() -> List[str]:
    workflows_dir = _get_workflows_dir()
    return sorted(rel_name for rel_name, _full_path in _iter_workflow_files(workflows_dir))


def get_workflows_dir_debug_info() -> Dict[str, Any]:
    """Small helper surfaced via the API so the frontend / user can see
    exactly which directory is being scanned, useful for diagnosing
    'my workflows aren't showing up' issues."""
    candidates = _candidate_workflow_dirs()
    resolved = _get_workflows_dir()
    return {
        "resolved_dir": str(resolved),
        "candidates": [
            {"path": str(c), "exists": c.is_dir(), "json_count": _count_json_files(c)}
            for c in candidates
        ],
    }

