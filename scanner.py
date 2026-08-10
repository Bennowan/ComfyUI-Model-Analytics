"""
scanner.py
Read-only inventory logic:
  - Physical inventory: walks all folder_paths model directories on disk.
  - Logical inventory:   parses saved workflow JSON files and pulls out any
                          string value that looks like a model filename.

Everything here is pure read/analysis - nothing is deleted or moved.
"""

import os
import json
import logging
from typing import Dict, List, Any

try:
    import folder_paths
except ImportError:  # allows the module to be imported/tested outside ComfyUI
    folder_paths = None

log = logging.getLogger("ModelAnalytics")

MODEL_EXTENSIONS = (".safetensors", ".ckpt", ".gguf", ".pt")

# folder_paths "kinds" we care about for the physical scan. We ask
# folder_paths for whatever it knows about rather than hardcoding disk paths.
MODEL_FOLDER_KEYS = [
    "checkpoints", "loras", "vae", "unet", "clip", "clip_vision",
    "controlnet", "upscale_models", "embeddings", "diffusion_models",
    "text_encoders", "style_models", "gligen", "hypernetworks",
]


def _get_model_root_dirs() -> Dict[str, List[str]]:
    """Ask ComfyUI's folder_paths for every known model directory kind."""
    roots: Dict[str, List[str]] = {}
    if folder_paths is None:
        return roots

    # Prefer whatever folder_paths actually knows about, in case a custom
    # node or newer ComfyUI version registered extra kinds.
    known_keys = list(getattr(folder_paths, "folder_names_and_paths", {}).keys())
    for key in known_keys or MODEL_FOLDER_KEYS:
        try:
            paths, _exts = folder_paths.folder_names_and_paths.get(key, ([], set()))
            if paths:
                roots[key] = list(paths)
        except Exception as e:
            log.warning("Could not resolve folder_paths kind '%s': %s", key, e)
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

    for kind, dirs in roots.items():
        for root_dir in dirs:
            if not root_dir or not os.path.isdir(root_dir):
                continue
            for dirpath, _dirnames, filenames in os.walk(root_dir):
                for fname in filenames:
                    if not fname.lower().endswith(MODEL_EXTENSIONS):
                        continue
                    abs_path = os.path.join(dirpath, fname)
                    rel_path = os.path.relpath(abs_path, root_dir).replace(os.sep, "/")
                    try:
                        size_bytes = os.path.getsize(abs_path)
                    except OSError as e:
                        log.warning("Could not stat %s: %s", abs_path, e)
                        size_bytes = 0
                    results.append({
                        "kind": kind,
                        "rel_path": rel_path,
                        "abs_path": abs_path,
                        "size_bytes": size_bytes,
                    })
    return results


def _get_workflows_dir() -> str:
    if folder_paths is None:
        return ""
    try:
        return os.path.join(folder_paths.get_user_directory(), "workflows")
    except Exception as e:
        log.warning("Could not resolve workflows dir: %s", e)
        return ""


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


def scan_workflows() -> Dict[str, List[str]]:
    """
    Logical inventory: maps a model filename (as it appears in the
    workflow JSON, e.g. "unet/Wan2.2-I2V.gguf" or just "model.safetensors")
    to the list of workflow filenames that reference it.
    """
    mapping: Dict[str, List[str]] = {}
    workflows_dir = _get_workflows_dir()
    if not workflows_dir or not os.path.isdir(workflows_dir):
        return mapping

    for fname in os.listdir(workflows_dir):
        if not fname.lower().endswith(".json"):
            continue
        full_path = os.path.join(workflows_dir, fname)
        try:
            with open(full_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            log.warning("Skipping unreadable workflow %s: %s", fname, e)
            continue

        for model_str in _iter_model_strings(data):
            # Normalize slashes so "unet\\foo.gguf" and "unet/foo.gguf" match.
            normalized = model_str.replace("\\", "/")
            mapping.setdefault(normalized, [])
            if fname not in mapping[normalized]:
                mapping[normalized].append(fname)

    return mapping


def list_workflow_names() -> List[str]:
    workflows_dir = _get_workflows_dir()
    if not workflows_dir or not os.path.isdir(workflows_dir):
        return []
    return sorted(f for f in os.listdir(workflows_dir) if f.lower().endswith(".json"))
