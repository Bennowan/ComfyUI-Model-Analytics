# ComfyUI Model Analytics Dashboard

A lightweight, read-only custom node for ComfyUI that helps you figure out which models you actually use and which ones are just wasting disk space.

[video-v1.4.4.webm](https://github.com/user-attachments/assets/8d2e397a-dd92-41e0-8d5d-3c3fe1f0a38e)


<table>
  <tr>
    <td><img src="./.docs/used-models-v1.4.4.png" alt="Used Models tab" width="480"/></td>
    <td><img src="./.docs/unused-models-v1.4.4.png" alt="Unused Models tab" width="480"/></td>
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
* **Live Tracking:** Hooks into model loading to record what actually gets loaded at runtime, and also notes which models a queued prompt names - so cached models and GGUF loaders are not missed.
* **Recency-Based Categorization:** A model counts as "Used" if it's referenced by any saved workflow, *or* it was loaded or queued within the last 7 days (configurable in the dashboard, and can be turned off entirely so any past load counts no matter how old). No permanent flags - outside of workflow references, a model quietly moves back to "Unused" once it's been idle long enough, and comes back the moment it's used again.
* **Extra Model Paths:** Folders declared in `extra_model_paths.yaml` are scanned too, even on another drive. Files ending in `.disabled` get their own tab.
* **Strictly Read-Only:** It only analyzes data. No files will ever be deleted or modified automatically.
* **Clean Dashboard:** Opens from one clearly placed entry point: a styled button in ComfyUI's legacy menu, or a custom-styled native action-bar button when the modern menu is enabled. The extension avoids registering duplicate visible entries. Tabs for used models, unused models, disabled files, workflow breakdowns, and settings.
* **Theme-Aware Design:** The dashboard follows ComfyUI by default. You can also select a palette from ComfyUI's palette registry for the dashboard only, or use the optional advanced appearance editor. Palette colours are read from ComfyUI's theme definitions and applied locally; the global interface and workflow canvas are not changed.
* **Multiple Languages:** English, German, Simplified Chinese, Traditional Chinese, Japanese, and Korean are supported. Automatic mode follows ComfyUI's language; a manually selected language stays selected.
* **In-Dashboard Settings:** Change the language, appearance, used/unused time window, size units (GiB/GB), row density, date format, and default tab directly in the dashboard Settings tab. Preferences are stored by ComfyUI. The GitHub star banner appears on first install and can be dismissed permanently with its close button. Table columns can be resized and rearranged by dragging their headers; each table remembers its layout locally. Vertical table scrolling uses a themed scrollbar and horizontal overflow is suppressed.

## Installation

1. Go to your ComfyUI custom nodes folder:

```bash
cd ComfyUI/custom_nodes/
```

2. Clone the repository:

```bash
git clone https://github.com/Bennowan/ComfyUI-Model-Analytics.git
```

3. Restart ComfyUI and use the single Model Analytics entry point: the native action-bar button when the modern ComfyUI menu is enabled, or the styled menu button in legacy-menu mode.

## Support

If this saved you some disk-space headaches, a ⭐ on GitHub helps other people find it.

## License

ComfyUI-Model-Analytics is licensed under the **Bennowan Community Non-Commercial License (BCNCL) v1.0**.

- **Non-commercial use only:** Commercial use, monetization, paid distribution, and other forms of financial gain are prohibited.
- **Attribution required:** Original copyright notices and credits must be preserved.
- **No independent mirrors:** Unchanged or substantially identical copies may not be published or maintained as separate projects.
- **Community contributions welcome:** Development forks and contributions to the official repository are permitted under the license terms.

The official project is maintained by **Bennowan**:

[github.com/Bennowan/ComfyUI-Model-Analytics](https://github.com/Bennowan/ComfyUI-Model-Analytics)

See the [LICENSE](./LICENSE) file for the complete terms.
