import { app } from "../../../scripts/app.js";

// Bump this whenever main.js/style.css change, so the injected <link> tag
// gets a fresh URL and browsers can't serve a stale cached copy of the CSS.
// (main.js itself is loaded by ComfyUI's own extension loader - if you
// don't see JS changes after an update, hard-refresh the browser tab,
// e.g. Ctrl+Shift+R / Cmd+Shift+R, or disable cache in devtools.)
const EXT_VERSION = "2";

const CSS_HREF = `${new URL("../css/style.css", import.meta.url).href}?v=${EXT_VERSION}`;

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
    this.sortState = { used: { col: "last_used", dir: -1 }, unused: { col: "size_bytes", dir: -1 } };
    this.selectedWorkflow = null;
    this.overlay = null;
    this.usedThresholdDays = 7;
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

    overlay.innerHTML = `
      <div class="ma-modal">
        <div class="ma-header">
          <h2>📊 Model Analytics Dashboard</h2>
          <div class="ma-header-right">
            <label class="ma-stale-control" title="A model counts as Used if it was loaded within this many days. Older or never-loaded models fall back to Unused automatically.">
              Used within last
              <input type="number" class="ma-stale-input" min="0" step="1" value="${this.usedThresholdDays}" />
              days
            </label>
            <button class="ma-close-btn" title="Close">✕</button>
          </div>
        </div>
        <div class="ma-tabs">
          <button class="ma-tab-btn" data-tab="used">Used Models</button>
          <button class="ma-tab-btn" data-tab="unused">Unused Models</button>
          <button class="ma-tab-btn" data-tab="workflow">Workflow View</button>
        </div>
        <div class="ma-body">
          <div class="ma-summary">Loading data…</div>
        </div>
      </div>
    `;

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
      if (!isNaN(val) && val >= 0) {
        this.usedThresholdDays = val;
        const body = overlay.querySelector(".ma-body");
        body.innerHTML = `<div class="ma-summary">Loading data…</div>`;
        await this.refresh();
      }
    });

    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  async refresh() {
    try {
      const res = await fetch(`/model_analytics/inventory?used_threshold_days=${encodeURIComponent(this.usedThresholdDays)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json();
      if (typeof this.data.used_threshold_days === "number") {
        this.usedThresholdDays = this.data.used_threshold_days;
      }
    } catch (e) {
      const body = this.overlay?.querySelector(".ma-body");
      if (body) {
        body.innerHTML = `<div class="ma-empty-state">Error loading data: ${e.message}</div>`;
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
    const used = this.data.models.filter((m) => !m.unused);
    const state = this.sortState.used;
    const sorted = this.sortRows(used, state.col, state.dir);

    if (!sorted.length) {
      return `<div class="ma-empty-state">No models used within the last ${this.usedThresholdDays} day(s).</div>`;
    }

    return `
      <div class="ma-summary"><b>${used.length}</b> used models out of <b>${this.data.total_models}</b> total (loaded within the last ${this.usedThresholdDays} day(s)).</div>
      <div class="ma-table-scroll">
        <table class="ma-table" data-table="used">
          <thead>
            <tr>
              ${this.headerCell("Name", "rel_path", "used")}
              ${this.headerCell("Size", "size_bytes", "used")}
              ${this.headerCell("Workflows", "workflows", "used")}
              ${this.headerCell("Uses", "use_count", "used")}
              ${this.headerCell("Last Used", "last_used", "used")}
            </tr>
          </thead>
          <tbody>
            ${sorted.map((m) => `
              <tr>
                <td title="${m.rel_path}">${m.rel_path}</td>
                <td>${formatBytes(m.size_bytes)}</td>
                <td title="${m.workflows.join(', ')}">${m.workflows.length ? m.workflows.join(", ") : "—"}</td>
                <td>${m.use_count}</td>
                <td>${formatDate(m.last_used)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  renderUnusedTab() {
    const unused = this.data.models.filter((m) => m.unused);
    const state = this.sortState.unused;
    const sorted = this.sortRows(unused, state.col, state.dir);
    const totalBytes = this.data.total_unused_bytes;

    if (!sorted.length) {
      return `<div class="ma-empty-state">No unused models found. 🎉</div>`;
    }

    return `
      <div class="ma-summary"><b>${unused.length}</b> unused models, totalling <b>${formatBytes(totalBytes)}</b> of disk space. A model lands here if it has never been used, or wasn't used within the last ${this.usedThresholdDays} day(s).</div>
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
                <td title="${m.rel_path}">${m.rel_path}</td>
                <td><span class="ma-badge">${m.kind}</span></td>
                <td>${formatBytes(m.size_bytes)}</td>
                <td>${formatDate(m.last_used)}</td>
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
        ${names.map((n) => `<option value="${n}" ${n === this.selectedWorkflow ? "selected" : ""}>${n}</option>`).join("")}
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
                  <td title="${m.rel_path}">${m.rel_path}</td>
                  <td><span class="ma-badge">${m.kind}</span></td>
                  <td>${formatBytes(m.size_bytes)}</td>
                  <td><span class="ma-badge ma-badge-used">found</span></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : `<div class="ma-empty-state">In "${this.selectedWorkflow}" references models that were not found on disk (or this workflow does not reference any model files).</div>`}
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
