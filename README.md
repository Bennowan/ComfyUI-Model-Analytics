# ComfyUI Model Analytics Dashboard

A lightweight, read-only custom node for ComfyUI that helps you figure out which models you actually use and which ones are just wasting disk space.

## Why I made this

I kept accumulating gigabytes of checkpoints, LoRAs, and UNets without knowing if they were still tied to any workflow or even loaded recently. This extension scans your setup and gives you a clear dashboard.

## What it does

* **Disk Scan:** Walks through all known model directories on your disk to find files.
* **Workflow Parser:** Checks your saved workflow JSON files to see which models are referenced.
* **Live VRAM Tracking:** Hooks into model-loading functions to track what actually gets loaded at runtime, so unrun workflows don't give false positives.
* **Strictly Read-Only:** It only analyzes data. No files will ever be deleted or modified automatically.
* **Clean Dashboard:** Adds a neat button to your ComfyUI menu with tabs for active models, dead weight, and workflow breakdowns.

## Installation

1. Go to your ComfyUI custom nodes folder:

```bash
cd ComfyUI/custom_nodes/
```

2. Clone the repository:

```bash
git clone https://github.com/Bennowan/ComfyUI-Model-Analytics.git
```

3. Restart ComfyUI and click the **"📊 Model Analytics"** button in the menu.

## License

Non-commercial. Check the LICENSE file for details.
