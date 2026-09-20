# ComfyUI Model Analytics Dashboard

A lightweight, read-only custom node for ComfyUI that helps you figure out which models you actually use and which ones are just wasting disk space.

https://github.com/user-attachments/assets/7dfe80a5-28de-42bc-8989-bc9301c4389b

<table>
  <tr>
    <td><img src="./.docs/used-models.png" alt="Used Models tab" width="480"/></td>
    <td><img src="./.docs/unused-models.png" alt="Unused Models tab" width="480"/></td>
  </tr>
  <tr>
    <td align="center"><sub>Used Models</sub></td>
    <td align="center"><sub>Unused Models</sub></td>
  </tr>
</table>

## Why I made this

I kept accumulating gigabytes of checkpoints, LoRAs, and UNets without knowing if they were still tied to any workflow or even loaded recently. This extension scans your setup and gives you a clear dashboard.

## What it does

* **Disk Scan:** Walks through all known model directories on your disk to find files.
* **Workflow Parser:** Checks your saved workflow JSON files to see which models are referenced.
* **Live VRAM Tracking:** Hooks into model-loading functions to track what actually gets loaded at runtime, so unrun workflows don't give false positives.
* **Recency-Based Categorization:** A model counts as "Used" if it's referenced by any saved workflow, *or* if it was loaded within the last 7 days (configurable in the dashboard, and can be turned off entirely so any past load counts no matter how old). No permanent flags — outside of workflow references, a model quietly moves back to "Unused" once it's been idle long enough, and comes back the moment it's loaded again.
* **Strictly Read-Only:** It only analyzes data. No files will ever be deleted or modified automatically.
* **Clean Dashboard:** Adds a neat button to your ComfyUI menu with tabs for used models, dead weight, and workflow breakdowns.

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

## Support

If this saved you some disk-space headaches, a ⭐ on GitHub helps other people find it.

## License

Non-commercial. Check the LICENSE file for details.
