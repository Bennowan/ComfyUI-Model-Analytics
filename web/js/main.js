import { app } from "../../../scripts/app.js";

// Bump this whenever main.js/style.css change, so the injected <link> tag
// gets a fresh URL and browsers can't serve a stale cached copy of the CSS.
// (main.js itself is loaded by ComfyUI's own extension loader - if you
// don't see JS changes after an update, hard-refresh the browser tab,
// e.g. Ctrl+Shift+R / Cmd+Shift+R, or disable cache in devtools.)
const EXT_VERSION = "5";

// >>> REPLACE THIS with your actual GitHub repo URL <<<
const GITHUB_REPO_URL = "https://github.com/Bennowan/ComfyUI-Model-Analytics";

const CSS_HREF = `${new URL("../css/style.css", import.meta.url).href}?v=${EXT_VERSION}`;

const STAR_BANNER_DISMISSED_KEY = "ma_star_banner_dismissed";
const USED_THRESHOLD_ENABLED_KEY = "ma_used_threshold_enabled";
const USED_THRESHOLD_DAYS_KEY = "ma_used_threshold_days";
const USED_REASON_LABELS = {
  recent_load: "Recently loaded",
  workflow_reference: "In a workflow",
  recent_load_and_workflow: "Recent + in a workflow",
};

// File names, workflow names and error messages are inserted via
// innerHTML, so everything that did not come from this file must be
// escaped - a model called  a"b<img onerror=...>.safetensors  must not
// break (or script) the dashboard.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function usedReasonCell(m) {
  const label = USED_REASON_LABELS[m.used_reason] || "—";
  const viaWorkflow = m.used_reason && m.used_reason.includes("workflow");
  if (viaWorkflow && (m.workflow_match === "suffix" || m.workflow_match === "basename")) {
    return `${label} <span title="Matched by file name / partial path only, not by the full path inside the models folder.">≈</span>`;
  }
  return label;
}

function injectCss() {
  const existing = document.querySelector('link[data-ma-style="1"]');
  if (existing) {
    if (existing.getAttribute("href") !== CSS_HREF) {
      existing.setAttribute("href", CSS_HREF);
    }
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.dataset.maStyle = "1";
  document.head.appendChild(link);
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

class ModelAnalyticsDashboard {
  constructor() {
    this.data = null;
    this.activeTab = "used";
    this.sortState = { used: { col: "last_used", dir: -1 }, unused: { col: "size_bytes", dir: -1 }, disabled: { col: "size_bytes", dir: -1 } };
    this.selectedWorkflow = null;
    this.overlay = null;
    this.usedThresholdDays = 7;
    // Whether the "Used within last N days" window applies at all. When
    // off, any past load (or a workflow reference) counts as used.
    this.usedThresholdEnabled = true;
    try {
      const stored = localStorage.getItem(USED_THRESHOLD_ENABLED_KEY);
      if (stored !== null) this.usedThresholdEnabled = stored === "1";
      const storedDays = parseFloat(localStorage.getItem(USED_THRESHOLD_DAYS_KEY));
      if (Number.isFinite(storedDays) && storedDays > 0) this.usedThresholdDays = storedDays;
    } catch {
      // localStorage can throw (private browsing etc.) - keep the default.
    }
  }

  async open() {
    injectCss();
    this.buildModal();
    await this.refresh();
  }

  close() {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  buildModal() {
    const overlay = document.createElement("div");
    overlay.className = "ma-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const showBanner = !localStorage.getItem(STAR_BANNER_DISMISSED_KEY);

    overlay.innerHTML = `
      <div class="ma-modal">
        <div class="ma-header">
          <h2>📊 Model Analytics Dashboard</h2>
          <div class="ma-header-right">
            <label class="ma-stale-control" title="A model referenced by a saved workflow always counts as Used. Additionally, a model counts as Used if it was loaded within this many days - uncheck to count any past load, no matter how long ago.">
              <input type="checkbox" class="ma-stale-toggle" ${this.usedThresholdEnabled ? "checked" : ""} />
              Used within last
              <input type="number" class="ma-stale-input" min="1" step="1" value="${this.usedThresholdDays}" ${this.usedThresholdEnabled ? "" : "disabled"} />
              days
            </label>
            <a class="ma-star-btn" href="${GITHUB_REPO_URL}" target="_blank" rel="noopener noreferrer" title="Star this project on GitHub">★ Star on GitHub</a>
            <button class="ma-close-btn" title="Close">✕</button>
          </div>
        </div>
        ${showBanner ? `
        <div class="ma-star-banner">
          <span>Enjoying this dashboard? A GitHub star helps other people find it.</span>
          <a href="${GITHUB_REPO_URL}" target="_blank" rel="noopener noreferrer">★ Star on GitHub</a>
          <button class="ma-star-banner-dismiss" title="Dismiss">✕</button>
        </div>
        ` : ""}
        <div class="ma-tabs">
          <button class="ma-tab-btn" data-tab="used">Used Models</button>
          <button class="ma-tab-btn" data-tab="unused">Unused Models</button>
          <button class="ma-tab-btn" data-tab="disabled">Disabled</button>
          <button class="ma-tab-btn" data-tab="workflow">Workflow View</button>
        </div>
        <div class="ma-body">
          <div class="ma-summary">Loading data…</div>
        </div>
      </div>
    `;

    const bannerDismiss = overlay.querySelector(".ma-star-banner-dismiss");
    if (bannerDismiss) {
      bannerDismiss.addEventListener("click", () => {
        localStorage.setItem(STAR_BANNER_DISMISSED_KEY, "1");
        overlay.querySelector(".ma-star-banner")?.remove();
      });
    }

    overlay.querySelector(".ma-close-btn").addEventListener("click", () => this.close());
    overlay.querySelectorAll(".ma-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.activeTab = btn.dataset.tab;
        this.render();
      });
    });

    const staleInput = overlay.querySelector(".ma-stale-input");
    staleInput.addEventListener("change", async () => {
      const val = parseFloat(staleInput.value);
      if (!isNaN(val) && val > 0) {
        this.usedThresholdDays = val;
        try {
          localStorage.setItem(USED_THRESHOLD_DAYS_KEY, String(val));
        } catch {
          // Non-fatal - the value just won't survive reopening.
        }
        const body = overlay.querySelector(".ma-body");
        body.innerHTML = `<div class="ma-summary">Loading data…</div>`;
        await this.refresh();
      }
    });

    const staleToggle = overlay.querySelector(".ma-stale-toggle");
    staleToggle.addEventListener("change", async () => {
      this.usedThresholdEnabled = staleToggle.checked;
      staleInput.disabled = !this.usedThresholdEnabled;
      try {
        localStorage.setItem(USED_THRESHOLD_ENABLED_KEY, this.usedThresholdEnabled ? "1" : "0");
      } catch {
        // Non-fatal - the preference just won't survive reopening.
      }
      const body = overlay.querySelector(".ma-body");
      body.innerHTML = `<div class="ma-summary">Loading data…</div>`;
      await this.refresh();
    });

    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  async refresh() {
    try {
      const thresholdParam = this.usedThresholdEnabled ? this.usedThresholdDays : "off";
      const res = await fetch(`/model_analytics/inventory?used_threshold_days=${encodeURIComponent(thresholdParam)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json();
      // When the filter is off the server sends null - keep the last typed
      // number so it is ready when the filter is re-enabled.
      if (typeof this.data.used_threshold_days === "number") {
        this.usedThresholdDays = this.data.used_threshold_days;
      }
      if (typeof this.data.used_threshold_enabled === "boolean") {
        this.usedThresholdEnabled = this.data.used_threshold_enabled;
      }
    } catch (e) {
      const body = this.overlay?.querySelector(".ma-body");
      if (body) {
        body.innerHTML = `<div class="ma-empty-state">Error loading data: ${escapeHtml(e.message)}</div>`;
      }
      return;
    }
    this.render();
  }

  render() {
    if (!this.overlay) return;
    this.overlay.querySelectorAll(".ma-tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === this.activeTab);
    });

    const body = this.overlay.querySelector(".ma-body");
    if (!this.data) {
      body.innerHTML = `<div class="ma-empty-state">No data available.</div>`;
      return;
    }

    if (this.activeTab === "used") {
      body.innerHTML = this.renderUsedTab();
    } else if (this.activeTab === "unused") {
      body.innerHTML = this.renderUnusedTab();
    } else if (this.activeTab === "disabled") {
      body.innerHTML = this.renderDisabledTab();
    } else {
      body.innerHTML = this.renderWorkflowTab();
    }

    this.attachSortHandlers(body);
    this.attachWorkflowSelectHandler(body);
  }

  sortRows(rows, col, dir) {
    return [...rows].sort((a, b) => {
      let va = a[col];
      let vb = b[col];
      if (va === null || va === undefined) va = "";
      if (vb === null || vb === undefined) vb = "";
      if (typeof va === "string") va = va.toLowerCase();
      if (typeof vb === "string") vb = vb.toLowerCase();
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }

  renderUsedTab() {
    const used = this.data.models.filter((m) => !m.unused && !m.disabled);
    const state = this.sortState.used;
    const sorted = this.sortRows(used, state.col, state.dir);
    const recencyNote = this.usedThresholdEnabled
      ? `loaded within the last ${this.usedThresholdDays} day(s)`
      : `loaded at any point (recency filter off)`;

    if (!sorted.length) {
      return `<div class="ma-empty-state">No models are currently referenced by a saved workflow, and none were ${recencyNote}.</div>`;
    }

    return `
      <div class="ma-summary"><b>${used.length}</b> used models out of <b>${this.data.total_models}</b> total — referenced by a saved workflow, and/or ${recencyNote}.</div>
      <div class="ma-table-scroll">
        <table class="ma-table" data-table="used">
          <thead>
            <tr>
              ${this.headerCell("Name", "rel_path", "used")}
              ${this.headerCell("Size", "size_bytes", "used")}
              ${this.headerCell("Workflows", "workflows", "used")}
              ${this.headerCell("Why", "used_reason", "used")}
              ${this.headerCell("Uses", "use_count", "used")}
              ${this.headerCell("Last Used", "last_used", "used")}
            </tr>
          </thead>
          <tbody>
            ${sorted.map((m) => `
              <tr>
                <td title="${escapeHtml(m.rel_path)}">${escapeHtml(m.rel_path)}</td>
                <td>${formatBytes(m.size_bytes)}</td>
                <td title="${escapeHtml(m.workflows.join(', '))}">${m.workflows.length ? escapeHtml(m.workflows.join(", ")) : "—"}</td>
                <td>${usedReasonCell(m)}</td>
                <td>${m.use_count}</td>
                <td>${escapeHtml(formatDate(m.last_used))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  renderUnusedTab() {
    const unused = this.data.models.filter((m) => m.unused && !m.disabled);
    const state = this.sortState.unused;
    const sorted = this.sortRows(unused, state.col, state.dir);
    const totalBytes = this.data.total_unused_bytes;
    const recencyNote = this.usedThresholdEnabled
      ? `wasn't loaded within the last ${this.usedThresholdDays} day(s)`
      : `has never been loaded`;

    if (!sorted.length) {
      return `<div class="ma-empty-state">No unused models found. 🎉</div>`;
    }

    return `
      <div class="ma-summary"><b>${unused.length}</b> unused models, totalling <b>${formatBytes(totalBytes)}</b> of disk space. A model lands here only if it's <b>not</b> referenced by any saved workflow, and ${recencyNote}.</div>
      <div class="ma-table-scroll">
        <table class="ma-table" data-table="unused">
          <thead>
            <tr>
              ${this.headerCell("Name", "rel_path", "unused")}
              ${this.headerCell("Category", "kind", "unused")}
              ${this.headerCell("Size", "size_bytes", "unused")}
              ${this.headerCell("Last Used", "last_used", "unused")}
            </tr>
          </thead>
          <tbody>
            ${sorted.map((m) => `
              <tr>
                <td title="${escapeHtml(m.rel_path)}">${escapeHtml(m.rel_path)}</td>
                <td><span class="ma-badge">${escapeHtml(m.kind)}</span></td>
                <td>${formatBytes(m.size_bytes)}</td>
                <td>${escapeHtml(formatDate(m.last_used))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  renderDisabledTab() {
    const disabled = this.data.models.filter((m) => m.disabled);
    const state = this.sortState.disabled;
    const sorted = this.sortRows(disabled, state.col, state.dir);

    if (!sorted.length) {
      return `<div class="ma-empty-state">No disabled model files found.</div>`;
    }

    return `
      <div class="ma-summary"><b>${sorted.length}</b> disabled model file(s) (name ends in <code>.disabled</code>), totalling <b>${formatBytes(this.data.total_disabled_bytes || 0)}</b>. They are counted as neither used nor unused.</div>
      <div class="ma-table-scroll">
        <table class="ma-table" data-table="disabled">
          <thead>
            <tr>
              ${this.headerCell("Name", "rel_path", "disabled")}
              ${this.headerCell("Category", "kind", "disabled")}
              ${this.headerCell("Size", "size_bytes", "disabled")}
            </tr>
          </thead>
          <tbody>
            ${sorted.map((m) => `
              <tr>
                <td title="${escapeHtml(m.rel_path)}">${escapeHtml(m.rel_path)}</td>
                <td><span class="ma-badge">${escapeHtml(m.kind)}</span></td>
                <td>${formatBytes(m.size_bytes)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  renderWorkflowTab() {
    const names = this.data.workflow_names || [];
    if (!names.length) {
      return `<div class="ma-empty-state">No saved workflows found.<br><span style="font-size:11px;">Save a workflow in ComfyUI (Workflow → Save) and it will show up here.</span></div>`;
    }
    if (!this.selectedWorkflow || !names.includes(this.selectedWorkflow)) {
      this.selectedWorkflow = names[0];
    }

    const modelsInWorkflow = this.data.models.filter((m) =>
      (m.workflows || []).includes(this.selectedWorkflow)
    );

    return `
      <select class="ma-select" data-role="workflow-select">
        ${names.map((n) => `<option value="${escapeHtml(n)}" ${n === this.selectedWorkflow ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}
      </select>
      ${modelsInWorkflow.length ? `
        <div class="ma-table-scroll">
          <table class="ma-table">
            <thead>
              <tr><th>Name</th><th>Category</th><th>Size</th><th>Status</th></tr>
            </thead>
            <tbody>
              ${modelsInWorkflow.map((m) => `
                <tr>
                  <td title="${escapeHtml(m.rel_path)}">${escapeHtml(m.rel_path)}</td>
                  <td><span class="ma-badge">${escapeHtml(m.kind)}</span></td>
                  <td>${formatBytes(m.size_bytes)}</td>
                  <td><span class="ma-badge ma-badge-used">found</span></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : `<div class="ma-empty-state">No model files from "${escapeHtml(this.selectedWorkflow)}" were found on disk (or this workflow does not reference any model files).</div>`}
    `;
  }

  headerCell(label, col, tableKey) {
    const state = this.sortState[tableKey];
    const arrow = state.col === col ? (state.dir === 1 ? "▲" : "▼") : "";
    return `<th data-col="${col}" data-table-key="${tableKey}">${label} <span class="ma-sort-arrow">${arrow}</span></th>`;
  }

  attachSortHandlers(body) {
    body.querySelectorAll("th[data-col]").forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.dataset.col;
        const tableKey = th.dataset.tableKey;
        const state = this.sortState[tableKey];
        if (state.col === col) {
          state.dir *= -1;
        } else {
          state.col = col;
          state.dir = 1;
        }
        this.render();
      });
    });
  }

  attachWorkflowSelectHandler(body) {
    const select = body.querySelector('[data-role="workflow-select"]');
    if (select) {
      select.addEventListener("change", () => {
        this.selectedWorkflow = select.value;
        this.render();
      });
    }
  }
}

app.registerExtension({
  name: "Comfy.ModelAnalytics",
  async setup() {
    injectCss();
    const dashboard = new ModelAnalyticsDashboard();

    const menuButton = document.createElement("button");
    menuButton.textContent = "📊 Model Analytics";
    menuButton.className = "comfy-menu-btn ma-menu-btn";
    menuButton.addEventListener("click", () => dashboard.open());

    // Try the modern ComfyUI menu API first, fall back to the legacy
    // .comfy-menu container so this keeps working across ComfyUI versions.
    if (app.menu?.settingsGroup?.element) {
      app.menu.settingsGroup.element.before(menuButton);
    } else {
      const menu = document.querySelector(".comfy-menu");
      if (menu) {
        menu.appendChild(menuButton);
      } else {
        // Last resort: floating button in the corner.
        menuButton.style.position = "fixed";
        menuButton.style.top = "10px";
        menuButton.style.right = "10px";
        menuButton.style.zIndex = "9999";
        document.body.appendChild(menuButton);
      }
    }
  },
});