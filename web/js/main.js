import { app } from "../../../scripts/app.js";

const CSS_HREF = new URL("../css/style.css", import.meta.url).href;

function injectCss() {
  if (document.querySelector(`link[href="${CSS_HREF}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
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
    this.activeTab = "active";
    this.sortState = { active: { col: "last_used", dir: -1 }, unused: { col: "size_bytes", dir: -1 } };
    this.selectedWorkflow = null;
    this.overlay = null;
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
          <button class="ma-close-btn" title="Close">✕</button>
        </div>
        <div class="ma-tabs">
          <button class="ma-tab-btn" data-tab="active">Aktive Modelle</button>
          <button class="ma-tab-btn" data-tab="unused">Ungenutzte Modelle</button>
          <button class="ma-tab-btn" data-tab="workflow">Workflow-Sicht</button>
        </div>
        <div class="ma-body">
          <div class="ma-summary">Lade Daten…</div>
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

    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  async refresh() {
    try {
      const res = await fetch("/model_analytics/inventory");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json();
    } catch (e) {
      const body = this.overlay?.querySelector(".ma-body");
      if (body) {
        body.innerHTML = `<div class="ma-empty-state">Fehler beim Laden der Daten: ${e.message}</div>`;
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
      body.innerHTML = `<div class="ma-empty-state">Keine Daten verfügbar.</div>`;
      return;
    }

    if (this.activeTab === "active") {
      body.innerHTML = this.renderActiveTab();
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

  renderActiveTab() {
    const active = this.data.models.filter((m) => !m.unused);
    const state = this.sortState.active;
    const sorted = this.sortRows(active, state.col, state.dir);

    if (!sorted.length) {
      return `<div class="ma-empty-state">Keine aktiven Modelle gefunden – weder in Workflows referenziert noch im Live-Tracking erfasst.</div>`;
    }

    return `
      <div class="ma-summary"><b>${active.length}</b> aktive Modelle von <b>${this.data.total_models}</b> insgesamt.</div>
      <table class="ma-table" data-table="active">
        <thead>
          <tr>
            ${this.headerCell("Name", "rel_path", "active")}
            ${this.headerCell("Größe", "size_bytes", "active")}
            ${this.headerCell("Workflows", "workflows", "active")}
            ${this.headerCell("Nutzungen", "use_count", "active")}
            ${this.headerCell("Zuletzt verwendet", "last_used", "active")}
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
    `;
  }

  renderUnusedTab() {
    const unused = this.data.models.filter((m) => m.unused);
    const state = this.sortState.unused;
    const sorted = this.sortRows(unused, state.col, state.dir);
    const totalBytes = this.data.total_unused_bytes;

    if (!sorted.length) {
      return `<div class="ma-empty-state">Keine ungenutzten Modelle gefunden. 🎉</div>`;
    }

    return `
      <div class="ma-summary"><b>${unused.length}</b> ungenutzte Modelle, zusammen <b>${formatBytes(totalBytes)}</b> Speicherplatz.</div>
      <table class="ma-table" data-table="unused">
        <thead>
          <tr>
            ${this.headerCell("Name", "rel_path", "unused")}
            ${this.headerCell("Kategorie", "kind", "unused")}
            ${this.headerCell("Größe", "size_bytes", "unused")}
          </tr>
        </thead>
        <tbody>
          ${sorted.map((m) => `
            <tr>
              <td title="${m.rel_path}">${m.rel_path}</td>
              <td><span class="ma-badge">${m.kind}</span></td>
              <td>${formatBytes(m.size_bytes)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  renderWorkflowTab() {
    const names = this.data.workflow_names || [];
    if (!names.length) {
      return `<div class="ma-empty-state">Keine gespeicherten Workflows gefunden.</div>`;
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
        <table class="ma-table">
          <thead>
            <tr><th>Name</th><th>Kategorie</th><th>Größe</th><th>Status</th></tr>
          </thead>
          <tbody>
            ${modelsInWorkflow.map((m) => `
              <tr>
                <td title="${m.rel_path}">${m.rel_path}</td>
                <td><span class="ma-badge">${m.kind}</span></td>
                <td>${formatBytes(m.size_bytes)}</td>
                <td><span class="ma-badge ma-badge-used">gefunden</span></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : `<div class="ma-empty-state">Keine der referenzierten Modelldateien wurde auf der Festplatte gefunden.</div>`}
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
