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
from typing import Dict, List, Any, Set

try:
    import folder_paths
except ImportError:  # allows the module to be imported/tested outside ComfyUI
    folder_paths = None

log = logging.getLogger("ModelAnalytics")

# .pth (upscalers, some ControlNets), .sft (Flux-style), .onnx and .bin
# (CLIP vision, misc. loaders) are used by real ComfyUI model folders too.
# Note: .bin can also appear in diffusers-style folders as sharded weights.
MODEL_EXTENSIONS = (".safetensors", ".ckpt", ".gguf", ".pt", ".pth", ".sft", ".onnx", ".bin")

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


def _extra_config_files() -> List[Path]:
    """The extra_model_paths config files ComfyUI itself loads: the default
    extra_model_paths.yaml in the ComfyUI base directory plus anything
    passed via --extra-model-paths-config."""
    files: List[Path] = []
    base = getattr(folder_paths, "base_path", None) if folder_paths is not None else None
    if base:
        files.append(Path(base) / "extra_model_paths.yaml")
    try:
        from comfy.cli_args import args
        configured = getattr(args, "extra_model_paths_config", None) or []
        # argparse "append" + nargs="+" gives a list of lists.
        for item in configured:
            for entry in (item if isinstance(item, (list, tuple)) else [item]):
                files.append(Path(entry))
    except Exception as e:
        log.debug("Could not read --extra-model-paths-config: %s", e)

    unique: List[Path] = []
    for f in files:
        try:
            if f.is_file() and f not in unique:
                unique.append(f)
        except OSError:
            continue
    return unique


def _extra_config_roots() -> Set[Path]:
    """Directories declared in extra_model_paths config files, resolved the
    same way ComfyUI's load_extra_path_config() does (base_path joined with
    each listed path; relative paths are relative to the YAML file).

    These are the ONLY directories outside models/ that the scanner accepts,
    so folders that custom nodes register on their own stay excluded.
    Entries that cannot be resolved here (e.g. shell-variable paths) are
    skipped, which just means those directories stay hidden as before."""
    roots: Set[Path] = set()
    try:
        import yaml
    except ImportError:
        return roots

    for cfg in _extra_config_files():
        try:
            config = yaml.safe_load(cfg.read_text(encoding="utf-8"))
        except Exception as e:
            log.debug("Could not parse %s: %s", cfg, e)
            continue
        if not isinstance(config, dict):
            continue
        yaml_dir = cfg.resolve().parent
        for section in config.values():
            if not isinstance(section, dict):
                continue
            base = None
            base_path = section.get("base_path")
            if isinstance(base_path, str) and base_path:
                base = Path(base_path).expanduser()
                if not base.is_absolute():
                    base = yaml_dir / base
            for key, value in section.items():
                if key in ("base_path", "is_default") or not isinstance(value, str):
                    continue
                for line in value.split("\n"):
                    line = line.strip()
                    if not line:
                        continue
                    entry = Path(line).expanduser()
                    if base is not None:
                        entry = base / entry  # an absolute entry replaces base
                    elif not entry.is_absolute():
                        entry = yaml_dir / entry
                    try:
                        roots.add(entry.resolve())
                    except OSError:
                        continue
    return roots


def _get_model_root_dirs() -> Dict[str, List[Path]]:
    """Ask ComfyUI's folder_paths for every known model directory kind,
    then keep only the ones that actually live inside the real models/
    root. This matters because custom nodes are able to register their
    own entries into folder_paths.folder_names_and_paths at runtime
    (e.g. via folder_paths.add_model_folder_path) to get their bundled
    assets recognized in ComfyUI's model dropdowns. Those directories are
    not part of the official models/ hierarchy and must never be scanned
    or shown in this dashboard, even though folder_paths itself makes no
    distinction between 'official' and 'custom-node-registered' entries.

    Exception: directories the user declared in extra_model_paths.yaml
    (or --extra-model-paths-config) are accepted even when they live
    outside models/, e.g. on another drive or in a shared A1111 folder."""
    roots: Dict[str, List[Path]] = {}
    if folder_paths is None:
        return roots

    base_models_dir = _get_base_models_dir()
    extra_roots = _extra_config_roots()

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
            declared_extra = any(resolved == r or r in resolved.parents for r in extra_roots)
            if (
                base_models_dir != Path()
                and base_models_dir not in resolved.parents
                and resolved != base_models_dir
                and not declared_extra
            ):
                log.debug("Skipping directory outside official models/ root for kind '%s': %s", key, resolved)
                continue
            kept_dirs.append(Path(d))
        if kept_dirs:
            roots[key] = kept_dirs
    return roots


def _safe_is_dir(path: Path) -> bool:
    """path.is_dir() can itself raise OSError on some broken junctions /
    inaccessible network paths on Windows, instead of just returning
    False like it does for a normal missing directory. Never let that
    kill the whole scan."""
    try:
        return path.is_dir()
    except OSError as e:
        log.warning("Could not check directory %s: %s", path, e)
        return False


def _iter_dir_files_safely(root_dir: Path):
    """
    Wraps root_dir.rglob("*") defensively.

    rglob() returns a generator, and on Windows in particular it's
    realistic for iterating it to raise OSError/PermissionError partway
    through - e.g. a broken junction/symlink, a network drive that
    disconnects mid-scan, a cloud-sync placeholder file (OneDrive/Google
    Drive "online-only" stubs), or a path exceeding MAX_PATH. Without this
    wrapper, a single such entry anywhere under any model root aborts the
    *entire* inventory request with a 500, even though every other file
    scanned fine. We catch mid-iteration failures and stop walking just
    that root directory, while still returning everything found before
    the failure and letting the other model-kind roots scan normally.
    """
    try:
        iterator = root_dir.rglob("*")
        while True:
            try:
                yield next(iterator)
            except StopIteration:
                return
    except OSError as e:
        log.warning("Stopped scanning %s after an OS error: %s", root_dir, e)
        return


def scan_disk_models() -> List[Dict[str, Any]]:
    """
    Physical inventory: walks every known model directory and returns
    a flat list of {kind, rel_path, abs_path, size_bytes}.

    rel_path is relative to its own model-kind root, and preserves nested
    subfolders (e.g. "chatterbox/chatterbox_multilingual/s3gen.pt") so that
    same-named files in different subfolders are never conflated.

    Defensive by design: every filesystem call in this function can fail
    independently on a real user's machine (permission errors, broken
    symlinks/junctions, disconnected network drives, races where a file
    disappears between being listed and being stat'ed). Each failure is
    caught at the narrowest possible scope and logged, so one bad file or
    directory degrades the result (that entry is skipped) instead of
    failing the entire /model_analytics/inventory request.
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
            if not _safe_is_dir(root_dir):
                continue
            for path in _iter_dir_files_safely(root_dir):
                try:
                    is_file = path.is_file()
                except OSError as e:
                    # Broken symlink/junction, or a race where the entry
                    # vanished between being listed and being checked.
                    log.debug("Could not check file type for %s: %s", path, e)
                    continue
                if not is_file:
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
                except OSError as e:
                    log.debug("Could not resolve %s, using unresolved path: %s", path, e)
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

                try:
                    rel_path = path.relative_to(root_dir).as_posix()
                except ValueError as e:
                    # Should not normally happen since path came from
                    # root_dir's own rglob(), but a resolved symlink
                    # target could in theory land outside root_dir.
                    log.debug("Could not compute relative path for %s under %s: %s", path, root_dir, e)
                    continue

                try:
                    size_bytes = path.stat().st_size
                except OSError as e:
                    # File disappeared between listing and stat (race),
                    # or a permission error on the specific file. Still
                    # include the entry with size 0 rather than dropping
                    # it entirely - better a slightly-wrong size than a
                    # missing model.
                    log.warning("Could not stat %s: %s", path, e)
                    size_bytes = 0
                try:
                    results.append({
                        "kind": kind,
                        "rel_path": rel_path,
                        "abs_path": str(path),
                        "size_bytes": size_bytes,
                        "disabled": classification["disabled"],
                    })
                except Exception as e:
                    # Last-resort safety net: should be unreachable given
                    # the checks above, but a single malformed entry must
                    # never take down the whole scan.
                    log.warning("Skipping model entry for %s due to unexpected error: %s", path, e)
                    continue

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
    if not _safe_is_dir(directory):
        return 0
    try:
        return sum(1 for p in _iter_dir_files_safely(directory) if p.name.lower().endswith(".json") and _safe_is_file(p))
    except Exception as e:
        log.debug("Could not count workflow files in %s: %s", directory, e)
        return 0


def _safe_is_file(path: Path) -> bool:
    try:
        return path.is_file()
    except OSError:
        return False


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


def iter_model_strings(obj: Any):
    """Recursively yield every string value in a JSON structure that looks
    like a model filename, regardless of which key/node it's nested under."""
    if isinstance(obj, dict):
        for v in obj.values():
            yield from iter_model_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from iter_model_strings(v)
    elif isinstance(obj, str):
        if obj.lower().endswith(MODEL_EXTENSIONS):
            yield obj


def _iter_workflow_files(workflows_dir: Path):
    """Yield (relative_name, absolute_path) for every workflow JSON file,
    recursing into subfolders (users can organize workflows into folders
    in the ComfyUI UI).

    Same rglob()-mid-iteration hardening as the model scanner: a broken
    symlink or inaccessible subfolder inside the workflows directory must
    not abort workflow discovery entirely."""
    if not _safe_is_dir(workflows_dir):
        return
    for path in _iter_dir_files_safely(workflows_dir):
        if not path.name.lower().endswith(".json"):
            continue
        try:
            is_file = path.is_file()
        except OSError as e:
            log.debug("Could not check file type for %s: %s", path, e)
            continue
        if not is_file:
            continue
        try:
            yield path.relative_to(workflows_dir).as_posix(), path
        except ValueError as e:
            log.debug("Could not compute relative path for workflow %s: %s", path, e)
            continue


def scan_workflows() -> Dict[str, List[str]]:
    """
    Logical inventory: maps a model filename (as it appears in the
    workflow JSON, e.g. "unet/Wan2.2-I2V.gguf" or just "model.safetensors")
    to the list of workflow filenames that reference it.

    Each workflow file is parsed independently and defensively: a single
    malformed, truncated, non-UTF8, permission-denied, or otherwise
    unreadable workflow file is skipped and logged rather than failing
    the entire dashboard request.
    """
    mapping: Dict[str, List[str]] = {}
    workflows_dir = _get_workflows_dir()

    for rel_name, full_path in _iter_workflow_files(workflows_dir):
        try:
            with full_path.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as e:
            # OSError: permission denied, file vanished mid-scan, etc.
            # JSONDecodeError: truncated/corrupt workflow save.
            # UnicodeDecodeError: file saved in a non-UTF8 encoding
            # (seen on some Windows setups) or a genuinely binary file
            # with a .json extension.
            log.warning("Skipping unreadable workflow %s: %s", rel_name, e)
            continue
        except Exception as e:
            # Safety net for any other unexpected parse failure - a
            # single bad workflow file must never take down the whole
            # inventory endpoint.
            log.warning("Skipping workflow %s due to unexpected error: %s", rel_name, e)
            continue

        try:
            for model_str in iter_model_strings(data):
                # Normalize slashes so "unet\\foo.gguf" and "unet/foo.gguf" match.
                normalized = model_str.replace("\\", "/")
                mapping.setdefault(normalized, [])
                if rel_name not in mapping[normalized]:
                    mapping[normalized].append(rel_name)
        except Exception as e:
            # iter_model_strings recurses through arbitrary user-authored
            # JSON; guard against unexpected shapes (e.g. extremely deep
            # nesting hitting Python's recursion limit).
            log.warning("Skipping model references from workflow %s due to unexpected error: %s", rel_name, e)
            continue

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

