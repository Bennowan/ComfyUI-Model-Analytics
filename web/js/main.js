import { app } from "../../../scripts/app.js";
import {
  LANGUAGES,
  FALLBACK_LANGUAGE,
  bold,
  code,
  createTranslator,
  escapeHtml,
  isSupportedLanguage,
  mapComfyLocale,
} from "./i18n/index.js";

// Bump this whenever main.js/style.css change, so the injected <link> tag
// gets a fresh URL and browsers can't serve a stale cached copy of the CSS.
// (main.js itself is loaded by ComfyUI's own extension loader - if you
// don't see JS changes after an update, hard-refresh the browser tab,
// e.g. Ctrl+Shift+R / Cmd+Shift+R, or disable cache in devtools.)
const EXT_VERSION = "10";

const GITHUB_REPO_URL = "https://github.com/Bennowan/ComfyUI-Model-Analytics";

const CSS_HREF = `${new URL("../css/style.css", import.meta.url).href}?v=${EXT_VERSION}`;

// Pre-1.2 builds remembered a dismissed star banner in localStorage. It is
// only read once, to carry that choice over into the ComfyUI setting.
const LEGACY_STAR_BANNER_DISMISSED_KEY = "ma_star_banner_dismissed";
const USED_THRESHOLD_ENABLED_KEY = "ma_used_threshold_enabled";
const USED_THRESHOLD_DAYS_KEY = "ma_used_threshold_days";

// ---------------------------------------------------------------------
// Settings (stored by ComfyUI's own settings system, so they are
// persistent, show up in Settings -> Model Analytics and need no
// backend endpoint of ours).
// ---------------------------------------------------------------------

const SETTING = {
  language: "ModelAnalytics.Language",
  sizeUnit: "ModelAnalytics.SizeUnit",
  density: "ModelAnalytics.RowDensity",
  dateFormat: "ModelAnalytics.DateFormat",
  defaultTab: "ModelAnalytics.DefaultTab",
  starBanner: "ModelAnalytics.ShowStarBanner",
  theme: "ModelAnalytics.Theme",
};
const COMFY_LOCALE_SETTING = "Comfy.Locale";

const LANGUAGE_AUTO = "auto";
const DATA_TABS = ["used", "unused", "disabled", "workflow"];
const TABS = [...DATA_TABS, "settings"];
const DASHBOARD_THEMES = ["auto", "dark", "light"];
const SIZE_UNITS = ["binary", "decimal"];
const DENSITIES = ["normal", "compact"];
const DATE_FORMATS = ["system", "iso"];

function readSetting(id, fallback) {
  try {
    const store = app.extensionManager?.setting;
    if (store && typeof store.get === "function") {
      const value = store.get(id);
      if (value !== undefined && value !== null) return value;
    }
  } catch {
    // fall through to the legacy settings API
  }
  try {
    const value = app.ui?.settings?.getSettingValue?.(id);
    if (value !== undefined && value !== null) return value;
  } catch {
    // ignore - use the fallback
  }
  return fallback;
}

async function writeSetting(id, value) {
  try {
    const store = app.extensionManager?.setting;
    if (store && typeof store.set === "function") {
      await store.set(id, value);
      return true;
    }
    const legacySetter = app.ui?.settings?.setSettingValue;
    if (typeof legacySetter === "function") {
      await legacySetter.call(app.ui.settings, id, value);
      return true;
    }
  } catch {
    // Non-fatal - the change just won't persist.
  }
  return false;
}

function readChoice(id, allowed, fallback) {
  const value = readSetting(id, fallback);
  return allowed.includes(value) ? value : fallback;
}

// The language the dashboard should use right now. A manual choice always
// wins and is never written by this extension; "auto" follows ComfyUI's
// own language and falls back to English when we do not ship it.
function resolveLanguage() {
  const preference = readSetting(SETTING.language, LANGUAGE_AUTO);
  if (preference !== LANGUAGE_AUTO && isSupportedLanguage(preference)) return preference;
  return mapComfyLocale(readSetting(COMFY_LOCALE_SETTING, FALLBACK_LANGUAGE));
}

function currentSettings() {
  return {
    sizeUnit: readChoice(SETTING.sizeUnit, SIZE_UNITS, "binary"),
    density: readChoice(SETTING.density, DENSITIES, "normal"),
    dateFormat: readChoice(SETTING.dateFormat, DATE_FORMATS, "system"),
    defaultTab: readChoice(SETTING.defaultTab, DATA_TABS, "used"),
    starBanner: readSetting(SETTING.starBanner, true) !== false,
    theme: readChoice(SETTING.theme, DASHBOARD_THEMES, "auto"),
  };
}

// ---------------------------------------------------------------------
// Theme: Auto uses ComfyUI's CSS variables; explicit Dark/Light overrides
// are scoped to the overlay in style.css. The background is also probed so
// native controls (select popups, checkboxes, scrollbars) use the right scheme.
// ---------------------------------------------------------------------

function parseColorToRgb(value) {
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(value);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
  return null;
}

function applyColorScheme(overlay) {
  try {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden;background-color:var(--ma-bg);";
    overlay.appendChild(probe);
    const rgb = parseColorToRgb(getComputedStyle(probe).backgroundColor);
    probe.remove();
    if (!rgb) return;
    const [r, g, b] = rgb;
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    overlay.style.colorScheme = luminance < 0.5 ? "dark" : "light";
  } catch {
    // Purely cosmetic - leave the browser default.
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

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

function formatBytes(bytes, unit) {
  if (!bytes) return "0 B";
  const decimal = unit === "decimal";
  const base = decimal ? 1000 : 1024;
  const units = decimal ? ["B", "KB", "MB", "GB", "TB"] : ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let val = bytes;
  while (val >= base && i < units.length - 1) {
    val /= base;
    i++;
  }
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso, format) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    if (format === "iso") {
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------

class ModelAnalyticsDashboard {
  constructor() {
    this.data = null;
    this.activeTab = "used";
    this.sortState = { used: { col: "last_activity", dir: -1 }, unused: { col: "size_bytes", dir: -1 }, disabled: { col: "size_bytes", dir: -1 } };
    this.selectedWorkflow = null;
    this.overlay = null;
    this.themeObserver = null;
    this.usedThresholdDays = 7;
    // Whether the "Used within last N days" window applies at all. When
    // off, any past load (or a workflow reference) counts as used.
    this.usedThresholdEnabled = true;
    this.loadSettings();
    try {
      const stored = localStorage.getItem(USED_THRESHOLD_ENABLED_KEY);
      if (stored !== null) this.usedThresholdEnabled = stored === "1";
      const storedDays = parseFloat(localStorage.getItem(USED_THRESHOLD_DAYS_KEY));
      if (Number.isFinite(storedDays) && storedDays > 0) this.usedThresholdDays = storedDays;
    } catch {
      // localStorage can throw (private browsing etc.) - keep the default.
    }
  }

  // Re-reads language + display settings. Called whenever the dashboard
  // opens or a setting changes, so "auto" always tracks ComfyUI.
  loadSettings() {
    this.tr = createTranslator(resolveLanguage());
    this.settings = currentSettings();
  }

  t(key, params) {
    return this.tr.t(key, params);
  }

  h(key, params) {
    return this.tr.tHtml(key, params);
  }

  async open() {
    injectCss();
    this.loadSettings();
    this.activeTab = this.settings.defaultTab;
    this.buildModal();
    await this.refresh();
  }

  close() {
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  // Called by the ComfyUI settings system when one of our settings
  // changes while the dashboard is open.
  onSettingsChanged() {
    this.loadSettings();
    if (!this.overlay) return;
    this.close();
    this.buildModal();
    if (this.data) this.render();
  }

  buildModal() {
    const overlay = document.createElement("div");
    overlay.className = "ma-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const showBanner = this.settings.starBanner;
    const densityClass = this.settings.density === "compact" ? " ma-density-compact" : "";
    overlay.dataset.maTheme = this.settings.theme;

    overlay.innerHTML = `
      <div class="ma-modal${densityClass}" role="dialog" aria-modal="true" aria-label="${this.h("app.title")}">
        <div class="ma-header">
          <h2>📊 ${this.h("app.title")}</h2>
          <div class="ma-header-right">
            <label class="ma-stale-control" title="${this.h("header.recency.tooltip")}">
              <input type="checkbox" class="ma-stale-toggle" ${this.usedThresholdEnabled ? "checked" : ""} />
              ${this.h("header.recency.before")}
              <input type="number" class="ma-stale-input" min="1" step="1" value="${escapeHtml(this.usedThresholdDays)}" ${this.usedThresholdEnabled ? "" : "disabled"} />
              ${this.h("header.recency.after")}
            </label>
            <a class="ma-btn ma-btn-accent ma-star-btn" href="${GITHUB_REPO_URL}" target="_blank" rel="noopener noreferrer" title="${this.h("star.tooltip")}">${this.h("star.button")}</a>
            <button type="button" class="ma-btn ma-btn-ghost ma-btn-icon ma-close-btn" title="${this.h("common.close")}" aria-label="${this.h("common.close")}">✕</button>
          </div>
        </div>
        ${showBanner ? `
        <div class="ma-star-banner">
          <span>${this.h("star.banner")}</span>
          <a class="ma-btn ma-btn-accent" href="${GITHUB_REPO_URL}" target="_blank" rel="noopener noreferrer">${this.h("star.button")}</a>
          <button type="button" class="ma-btn ma-btn-ghost ma-btn-icon ma-star-banner-dismiss" title="${this.h("common.dismiss")}" aria-label="${this.h("common.dismiss")}">✕</button>
        </div>
        ` : ""}
        <div class="ma-tabs" role="tablist">
          ${TABS.map((tab) => `<button type="button" role="tab" class="ma-tab-btn" data-tab="${tab}">${this.h(`tab.${tab}`)}</button>`).join("")}
        </div>
        <div class="ma-body">
          <div class="ma-summary">${this.h("common.loading")}</div>
        </div>
      </div>
    `;

    const bannerDismiss = overlay.querySelector(".ma-star-banner-dismiss");
    if (bannerDismiss) {
      bannerDismiss.addEventListener("click", () => {
        // Remove it right away; the setting makes the choice permanent
        // (and re-enableable in Settings -> Model Analytics).
        this.settings.starBanner = false;
        overlay.querySelector(".ma-star-banner")?.remove();
        writeSetting(SETTING.starBanner, false);
      });
    }

    overlay.querySelector(".ma-close-btn").addEventListener("click", () => this.close());
    overlay.querySelectorAll(".ma-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.activeTab = btn.dataset.tab;
        this.render();
      });
    });
    this.attachSettingsHandlers(overlay.querySelector(".ma-body"));

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
        body.innerHTML = `<div class="ma-summary">${this.h("common.loading")}</div>`;
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
      body.innerHTML = `<div class="ma-summary">${this.h("common.loading")}</div>`;
      await this.refresh();
    });

    document.body.appendChild(overlay);
    this.overlay = overlay;
    applyColorScheme(overlay);

    // Theme colours update automatically through CSS variables. Observe the
    // root/body theme attributes as well so native controls also switch their
    // light/dark colour scheme while the dashboard remains open.
    if (typeof MutationObserver !== "undefined") {
      this.themeObserver = new MutationObserver(() => applyColorScheme(overlay));
      const observerOptions = { attributes: true, attributeFilter: ["class", "style", "data-theme"] };
      this.themeObserver.observe(document.documentElement, observerOptions);
      this.themeObserver.observe(document.body, observerOptions);
    }
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
        body.innerHTML = `<div class="ma-empty-state">${this.h("common.loadError", { message: e.message })}</div>`;
      }
      return;
    }
    this.render();
  }

  render() {
    if (!this.overlay) return;
    this.overlay.querySelectorAll(".ma-tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === this.activeTab;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    const body = this.overlay.querySelector(".ma-body");
    if (this.activeTab === "settings") {
      body.innerHTML = this.renderSettingsTab();
      return;
    }
    if (!this.data) {
      body.innerHTML = `<div class="ma-empty-state">${this.h("common.noData")}</div>`;
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

  settingOptions(id) {
    const tr = this.tr;
    const choices = {
      [SETTING.language]: [
        { value: LANGUAGE_AUTO, text: tr.t("settings.language.auto") },
        ...LANGUAGES.map((language) => ({ value: language.code, text: language.label })),
      ],
      [SETTING.theme]: [
        { value: "auto", text: tr.t("settings.theme.auto") },
        { value: "dark", text: tr.t("settings.theme.dark") },
        { value: "light", text: tr.t("settings.theme.light") },
      ],
      [SETTING.sizeUnit]: [
        { value: "binary", text: tr.t("settings.sizeUnit.binary") },
        { value: "decimal", text: tr.t("settings.sizeUnit.decimal") },
      ],
      [SETTING.density]: [
        { value: "normal", text: tr.t("settings.density.normal") },
        { value: "compact", text: tr.t("settings.density.compact") },
      ],
      [SETTING.dateFormat]: [
        { value: "system", text: tr.t("settings.dateFormat.system") },
        { value: "iso", text: tr.t("settings.dateFormat.iso") },
      ],
      [SETTING.defaultTab]: DATA_TABS.map((tab) => ({ value: tab, text: tr.t(`tab.${tab}`) })),
    };
    return choices[id] || [];
  }

  renderSettingSelect(id, titleKey, tooltipKey, value) {
    const options = this.settingOptions(id).map((option) =>
      `<option value="${escapeHtml(option.value)}" ${option.value === value ? "selected" : ""}>${escapeHtml(option.text)}</option>`,
    ).join("");
    return `
      <label class="ma-setting-row">
        <span class="ma-setting-copy">
          <span class="ma-setting-title">${this.h(titleKey)}</span>
          <span class="ma-setting-description">${this.h(tooltipKey)}</span>
        </span>
        <select class="ma-select ma-settings-select" data-setting="${escapeHtml(id)}" aria-label="${this.h(titleKey)}">${options}</select>
      </label>
    `;
  }

  renderSettingsTab() {
    const language = readChoice(SETTING.language, [LANGUAGE_AUTO, ...LANGUAGES.map((item) => item.code)], LANGUAGE_AUTO);
    const theme = readChoice(SETTING.theme, DASHBOARD_THEMES, "auto");
    const starBanner = this.settings.starBanner;
    return `
      <div class="ma-settings-page">
        <p class="ma-settings-intro">${this.h("settings.panel.description")}</p>
        <section class="ma-settings-section">
          <h3>${this.h("settings.group.general")}</h3>
          ${this.renderSettingSelect(SETTING.language, "settings.language.name", "settings.language.tooltip", language)}
        </section>
        <section class="ma-settings-section">
          <h3>${this.h("settings.group.appearance")}</h3>
          ${this.renderSettingSelect(SETTING.theme, "settings.theme.name", "settings.theme.tooltip", theme)}
          ${this.renderSettingSelect(SETTING.density, "settings.density.name", "settings.density.tooltip", this.settings.density)}
        </section>
        <section class="ma-settings-section">
          <h3>${this.h("settings.group.display")}</h3>
          ${this.renderSettingSelect(SETTING.sizeUnit, "settings.sizeUnit.name", "settings.sizeUnit.tooltip", this.settings.sizeUnit)}
          ${this.renderSettingSelect(SETTING.dateFormat, "settings.dateFormat.name", "settings.dateFormat.tooltip", this.settings.dateFormat)}
          ${this.renderSettingSelect(SETTING.defaultTab, "settings.defaultTab.name", "settings.defaultTab.tooltip", this.settings.defaultTab)}
          <label class="ma-setting-row ma-setting-toggle-row">
            <span class="ma-setting-copy">
              <span class="ma-setting-title">${this.h("settings.starBanner.name")}</span>
              <span class="ma-setting-description">${this.h("settings.starBanner.tooltip")}</span>
            </span>
            <input class="ma-settings-checkbox" type="checkbox" data-setting="${escapeHtml(SETTING.starBanner)}" ${starBanner ? "checked" : ""} aria-label="${this.h("settings.starBanner.name")}" />
          </label>
        </section>
        <p class="ma-settings-feedback" role="status" aria-live="polite"></p>
      </div>
    `;
  }

  attachSettingsHandlers(root) {
    if (!root || root.dataset.maSettingsHandlers === "true") return;
    root.dataset.maSettingsHandlers = "true";
    const persist = async (control) => {
      const id = control.dataset.setting;
      const value = control.type === "checkbox" ? control.checked : control.value;
      const previous = readSetting(id, control.type === "checkbox" ? true : control.value);
      const saved = await writeSetting(id, value);
      if (!saved) {
        if (control.type === "checkbox") control.checked = previous !== false;
        else control.value = String(previous);
        const feedback = root.querySelector(".ma-settings-feedback");
        if (feedback) feedback.textContent = this.t("settings.saveError");
        return;
      }

      // ComfyUI normally invokes the registered onChange callback from
      // setting.set(). Also compare the current values here so the dashboard
      // still refreshes on ComfyUI builds that do not emit that callback.
      const languageChanged = this.tr.code !== resolveLanguage();
      const next = currentSettings();
      const settingsChanged = Object.keys(next).some((key) => next[key] !== this.settings[key]);
      if (languageChanged || settingsChanged) this.onSettingsChanged();
    };

    // Delegate from the stable body element because tab contents are replaced
    // on every render. This keeps controls working after switching tabs.
    root.addEventListener("change", (event) => {
      const control = event.target?.closest?.("[data-setting]");
      if (control && root.contains(control)) persist(control);
    });
  }

  size(bytes) {
    return formatBytes(bytes, this.settings.sizeUnit);
  }

  date(iso) {
    return formatDate(iso, this.settings.dateFormat);
  }

  usedReasonCell(m) {
    const parts = (m.used_reason || "").split("+").filter(Boolean);
    const label = parts.length
      ? parts.map((p) => {
          const key = `reason.${p}`;
          const translated = this.t(key);
          return translated === key ? p : translated;
        }).join(", ")
      : "—";
    const viaWorkflow = parts.includes("workflow_reference");
    if (viaWorkflow && (m.workflow_match === "suffix" || m.workflow_match === "basename")) {
      return `${escapeHtml(label)} <span title="${this.h("reason.approxTooltip")}">≈</span>`;
    }
    return escapeHtml(label);
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
    const variant = this.usedThresholdEnabled ? "window" : "all";
    const days = this.usedThresholdDays;

    if (!sorted.length) {
      return `<div class="ma-empty-state">${this.h(`used.empty.${variant}`, { days })}</div>`;
    }

    return `
      <div class="ma-summary">${this.h(`used.summary.${variant}`, { used: bold(used.length), total: bold(this.data.total_models), days })}</div>
      <div class="ma-table-scroll">
        <table class="ma-table" data-table="used">
          <thead>
            <tr>
              ${this.headerCell("col.name", "rel_path", "used")}
              ${this.headerCell("col.size", "size_bytes", "used")}
              ${this.headerCell("col.workflows", "workflows", "used")}
              ${this.headerCell("col.why", "used_reason", "used")}
              ${this.headerCell("col.loads", "use_count", "used")}
              ${this.headerCell("col.queued", "queue_count", "used")}
              ${this.headerCell("col.lastUsed", "last_activity", "used")}
            </tr>
          </thead>
          <tbody>
            ${sorted.map((m) => `
              <tr>
                <td title="${escapeHtml(m.rel_path)}">${escapeHtml(m.rel_path)}</td>
                <td>${this.size(m.size_bytes)}</td>
                <td title="${escapeHtml(m.workflows.join(', '))}">${m.workflows.length ? escapeHtml(m.workflows.join(", ")) : "—"}</td>
                <td>${this.usedReasonCell(m)}</td>
                <td>${m.use_count}</td>
                <td>${m.queue_count || 0}</td>
                <td>${escapeHtml(this.date(m.last_activity))}</td>
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
    const variant = this.usedThresholdEnabled ? "window" : "all";

    if (!sorted.length) {
      return `<div class="ma-empty-state">${this.h("unused.empty")}</div>`;
    }

    return `
      <div class="ma-summary">${this.h(`unused.summary.${variant}`, { count: bold(unused.length), size: bold(this.size(totalBytes)), days: this.usedThresholdDays })}</div>
      <div class="ma-table-scroll">
        <table class="ma-table" data-table="unused">
          <thead>
            <tr>
              ${this.headerCell("col.name", "rel_path", "unused")}
              ${this.headerCell("col.category", "kind", "unused")}
              ${this.headerCell("col.size", "size_bytes", "unused")}
              ${this.headerCell("col.lastUsed", "last_activity", "unused")}
            </tr>
          </thead>
          <tbody>
            ${sorted.map((m) => `
              <tr>
                <td title="${escapeHtml(m.rel_path)}">${escapeHtml(m.rel_path)}</td>
                <td><span class="ma-badge">${escapeHtml(m.kind)}</span></td>
                <td>${this.size(m.size_bytes)}</td>
                <td>${escapeHtml(this.date(m.last_activity))}</td>
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
      return `<div class="ma-empty-state">${this.h("disabled.empty")}</div>`;
    }

    return `
      <div class="ma-summary">${this.h("disabled.summary", { count: bold(sorted.length), suffix: code(".disabled"), size: bold(this.size(this.data.total_disabled_bytes || 0)) })}</div>
      <div class="ma-table-scroll">
        <table class="ma-table" data-table="disabled">
          <thead>
            <tr>
              ${this.headerCell("col.name", "rel_path", "disabled")}
              ${this.headerCell("col.category", "kind", "disabled")}
              ${this.headerCell("col.size", "size_bytes", "disabled")}
            </tr>
          </thead>
          <tbody>
            ${sorted.map((m) => `
              <tr>
                <td title="${escapeHtml(m.rel_path)}">${escapeHtml(m.rel_path)}</td>
                <td><span class="ma-badge">${escapeHtml(m.kind)}</span></td>
                <td>${this.size(m.size_bytes)}</td>
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
      return `<div class="ma-empty-state">${this.h("workflow.empty")}<br><span class="ma-hint">${this.h("workflow.emptyHint")}</span></div>`;
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
              <tr><th>${this.h("col.name")}</th><th>${this.h("col.category")}</th><th>${this.h("col.size")}</th><th>${this.h("col.status")}</th></tr>
            </thead>
            <tbody>
              ${modelsInWorkflow.map((m) => `
                <tr>
                  <td title="${escapeHtml(m.rel_path)}">${escapeHtml(m.rel_path)}</td>
                  <td><span class="ma-badge">${escapeHtml(m.kind)}</span></td>
                  <td>${this.size(m.size_bytes)}</td>
                  <td><span class="ma-badge ma-badge-used">${this.h("workflow.found")}</span></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : `<div class="ma-empty-state">${this.h("workflow.noModels", { name: this.selectedWorkflow })}</div>`}
    `;
  }

  headerCell(labelKey, col, tableKey) {
    const state = this.sortState[tableKey];
    const arrow = state.col === col ? (state.dir === 1 ? "▲" : "▼") : "";
    return `<th data-col="${col}" data-table-key="${tableKey}">${this.h(labelKey)} <span class="ma-sort-arrow">${arrow}</span></th>`;
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

// ---------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------

let dashboard = null;
let menuButton = null;

function updateMenuButtonLabel() {
  if (!menuButton) return;
  const tr = createTranslator(resolveLanguage());
  menuButton.textContent = `📊 ${tr.t("app.menuButton")}`;
}

function onAnySettingChanged() {
  // ComfyUI also fires onChange once per setting while registering them,
  // before the dashboard exists - hence the guards.
  updateMenuButtonLabel();
  dashboard?.onSettingsChanged();
}

// Setting labels are resolved when ComfyUI registers them, so they use the
// language that is active at page load (a language change shows up in
// the settings dialog after the next reload; the dashboard itself updates
// immediately).
function buildSettingsDefinitions() {
  const { t } = createTranslator(resolveLanguage());
  const section = "Model Analytics";
  const general = t("settings.group.general");
  const display = t("settings.group.display");

  const combo = (id, group, nameKey, tipKey, options, defaultValue) => ({
    id,
    name: t(nameKey),
    category: [section, group, t(nameKey)],
    type: "combo",
    tooltip: t(tipKey),
    options,
    defaultValue,
    onChange: onAnySettingChanged,
  });

  return [
    combo(
      SETTING.language, general, "settings.language.name", "settings.language.tooltip",
      [
        { text: t("settings.language.auto"), value: LANGUAGE_AUTO },
        ...LANGUAGES.map((l) => ({ text: l.label, value: l.code })),
      ],
      LANGUAGE_AUTO,
    ),
    combo(
      SETTING.sizeUnit, display, "settings.sizeUnit.name", "settings.sizeUnit.tooltip",
      [
        { text: t("settings.sizeUnit.binary"), value: "binary" },
        { text: t("settings.sizeUnit.decimal"), value: "decimal" },
      ],
      "binary",
    ),
    combo(
      SETTING.density, display, "settings.density.name", "settings.density.tooltip",
      [
        { text: t("settings.density.normal"), value: "normal" },
        { text: t("settings.density.compact"), value: "compact" },
      ],
      "normal",
    ),
    combo(
      SETTING.dateFormat, display, "settings.dateFormat.name", "settings.dateFormat.tooltip",
      [
        { text: t("settings.dateFormat.system"), value: "system" },
        { text: t("settings.dateFormat.iso"), value: "iso" },
      ],
      "system",
    ),
    combo(
      SETTING.defaultTab, display, "settings.defaultTab.name", "settings.defaultTab.tooltip",
      DATA_TABS.map((tab) => ({ text: t(`tab.${tab}`), value: tab })),
      "used",
    ),
    {
      id: SETTING.starBanner,
      name: t("settings.starBanner.name"),
      category: [section, display, t("settings.starBanner.name")],
      type: "boolean",
      tooltip: t("settings.starBanner.tooltip"),
      defaultValue: true,
      onChange: onAnySettingChanged,
    },
    combo(
      SETTING.theme, t("settings.group.appearance"), "settings.theme.name", "settings.theme.tooltip",
      [
        { text: t("settings.theme.auto"), value: "auto" },
        { text: t("settings.theme.dark"), value: "dark" },
        { text: t("settings.theme.light"), value: "light" },
      ],
      "auto",
    ),
  ];
}

// One-time carry-over of the old localStorage "banner dismissed" flag into
// the ComfyUI setting, so people who already dismissed it do not see it
// again after updating.
async function migrateLegacyStarBannerFlag() {
  try {
    if (localStorage.getItem(LEGACY_STAR_BANNER_DISMISSED_KEY)) {
      const migrated = await writeSetting(SETTING.starBanner, false);
      if (migrated) localStorage.removeItem(LEGACY_STAR_BANNER_DISMISSED_KEY);
    }
  } catch {
    // localStorage unavailable - nothing to migrate.
  }
}

app.registerExtension({
  name: "Comfy.ModelAnalytics",
  settings: buildSettingsDefinitions(),
  commands: [
    {
      id: "ModelAnalytics.Open",
      label: "Model Analytics",
      icon: "pi pi-chart-bar",
      function: () => dashboard?.open(),
    },
  ],
  async setup() {
    injectCss();
    dashboard = new ModelAnalyticsDashboard();
    await migrateLegacyStarBannerFlag();

    menuButton = document.createElement("button");
    menuButton.className = "comfy-menu-btn ma-btn ma-menu-btn";
    updateMenuButtonLabel();
    menuButton.addEventListener("click", () => {
      updateMenuButtonLabel();
      dashboard.open();
    });

    // Try the modern ComfyUI menu API first, fall back to the legacy
    // .comfy-menu container so this keeps working across ComfyUI versions.
    if (app.menu?.settingsGroup?.element) {
      app.menu.settingsGroup.element.before(menuButton);
    } else {
      const menu = document.querySelector(".comfy-menu");
      if (menu) {
        menu.appendChild(menuButton);
      } else {
        // Last resort: floating button in the corner (styled in style.css).
        menuButton.className = "comfy-menu-btn ma-btn ma-floating-btn ma-menu-btn";
        document.body.appendChild(menuButton);
      }
    }
  },
});
