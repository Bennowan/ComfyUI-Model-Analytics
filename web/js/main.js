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
import {
  BUILTIN_COMFY_PALETTES,
  COLOR_TOKENS,
  FONT_SIZE_RANGE,
  RADIUS_RANGE,
  SCHEMES,
  applyAppearance,
  effectiveTokenHex,
  parseCustomAppearance,
  readComfyPaletteSnapshot,
  serializeCustomAppearance,
} from "./appearance.js";
import { calculateInventoryStats } from "./inventory-stats.js";
import { renderCustomNodeTabs } from "./custom-node-analytics.js";
import {
  findUsedInventoryModels,
  findUnusedInventoryModels,
  findUsedCustomNodePackages,
  findUnusedCustomNodePackages,
  USAGE_SOURCES,
} from "./usage-analytics.js";
import {
  normalizeTableLayout,
  reorderTableColumn,
  resizeAdjacentColumns,
  getResizableColumnIds,
} from "./table-layout.js";

// Bump this whenever main.js/style.css change, so the injected <link> tag
// gets a fresh URL and browsers can't serve a stale cached copy of the CSS.
// (main.js itself is loaded by ComfyUI's own extension loader - if you
// don't see JS changes after an update, hard-refresh the browser tab,
// e.g. Ctrl+Shift+R / Cmd+Shift+R, or disable cache in devtools.)
const EXT_VERSION = "156";

const GITHUB_REPO_URL = "https://github.com/Bennowan/ComfyUI-Model-Analytics";

const CSS_HREF = `${new URL("../css/style.css", import.meta.url).href}?v=${EXT_VERSION}`;

// Older builds kept a few preferences in the browser's localStorage. They
// are only read once at startup, to carry the values over into the ComfyUI
// settings (and are then removed), so existing choices are not lost.
const LEGACY_STAR_BANNER_DISMISSED_KEY = "ma_star_banner_dismissed";
const LEGACY_USED_THRESHOLD_ENABLED_KEY = "ma_used_threshold_enabled";
const LEGACY_USED_THRESHOLD_DAYS_KEY = "ma_used_threshold_days";
const DEFAULT_RECENCY_DAYS = 7;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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
  starBannerDismissed: "ModelAnalytics.StarBannerDismissed",
  legacyTheme: "ModelAnalytics.Theme",
  appearance: "ModelAnalytics.Appearance",
  customAppearance: "ModelAnalytics.CustomAppearance",
  tableLayout: "ModelAnalytics.TableLayout",
  recencyEnabled: "ModelAnalytics.RecencyEnabled",
  recencyDays: "ModelAnalytics.RecencyDays",
  usageSource: "ModelAnalytics.UsageSource",
  defaultSection: "ModelAnalytics.DefaultSection",
  customNodeTrackingEnabled: "ModelAnalytics.CustomNodes.TrackingEnabled",
  customNodeScanWorkflows: "ModelAnalytics.CustomNodes.ScanWorkflows",
};
const COMFY_LOCALE_SETTING = "Comfy.Locale";
// "Disabled" means ComfyUI shows its legacy floating menu instead of the
// new top menu / action bar.
const COMFY_MENU_SETTING = "Comfy.UseNewMenu";

const LANGUAGE_AUTO = "auto";
const DATA_TABS = ["used", "unused", "disabled", "workflow"];
const TABS = ["models", "customNodes", "settings"];

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
function normalizeAppearancePreference(value) {
  if (value === "custom" || value === "follow") return value;
  if (typeof value === "string" && value.startsWith("palette:")) {
    const id = value.slice("palette:".length).trim();
    if (id && /^[a-z0-9_-]+$/i.test(id)) return `palette:${id}`;
  }
  // One-time compatibility with the previous Auto / Dark / Light setting.
  if (value === undefined || value === null || value === "") {
    const legacy = readSetting(SETTING.legacyTheme, "auto");
    if (legacy === "dark" || legacy === "light") return `palette:${legacy}`;
  }
  return "follow";
}

function getAppearanceMode(preference) {
  if (preference === "custom") return "custom";
  return preference.startsWith("palette:") ? "palette" : "follow";
}

function getAppearancePaletteId(preference) {
  return preference.startsWith("palette:") ? preference.slice("palette:".length) : "";
}

function getComfyPaletteStore() {
  // ComfyUI currently keeps its palette registry in a Pinia store. It is not
  // part of the documented ExtensionManager API, so discover it defensively
  // and fall back to the public custom-palette setting when unavailable.
  const mounts = [
    document.getElementById("vue-app"),
    document.getElementById("app"),
    document.querySelector("[data-v-app]"),
  ].filter(Boolean);
  for (const mount of mounts) {
    const vueApp = mount.__vue_app__;
    const context = vueApp?._context;
    if (!context) continue;
    const globals = context.config?.globalProperties;
    const provides = context.provides || {};
    const candidates = [globals?.$pinia];
    for (const key of Reflect.ownKeys(provides)) candidates.push(provides[key]);
    const pinia = candidates.find((candidate) => candidate?._s && typeof candidate._s.values === "function");
    if (!pinia) continue;
    for (const store of pinia._s.values()) {
      if (store?.palettesLookup && typeof store.completePalette === "function") return store;
    }
  }
  return null;
}

function getCustomComfyPalettes() {
  let custom = readSetting("Comfy.CustomColorPalettes", {});
  if (typeof custom === "string") {
    try { custom = JSON.parse(custom); } catch { custom = {}; }
  }
  return custom && typeof custom === "object" && !Array.isArray(custom) ? custom : {};
}

function getComfyPaletteChoices() {
  const store = getComfyPaletteStore();
  const choices = new Map();
  if (store?.palettesLookup) {
    for (const [id, palette] of Object.entries(store.palettesLookup)) {
      if (!/^[a-z0-9_-]+$/i.test(id) || !palette || typeof palette !== "object") continue;
      choices.set(id, { id, name: palette.name || id });
    }
  }
  for (const [id, palette] of Object.entries(getCustomComfyPalettes())) {
    if (!/^[a-z0-9_-]+$/i.test(id) || !palette || typeof palette !== "object") continue;
    choices.set(id, { id, name: typeof palette.name === "string" && palette.name.trim() ? palette.name.trim() : id });
  }
  const activeId = readSetting("Comfy.ColorPalette", "dark");
  if (activeId && !choices.has(activeId)) {
    choices.set(activeId, { id: activeId, name: activeId });
  }
  return [...choices.values()].sort((a, b) => {
    const aIndex = BUILTIN_COMFY_PALETTES.findIndex((item) => item.id === a.id);
    const bIndex = BUILTIN_COMFY_PALETTES.findIndex((item) => item.id === b.id);
    if (aIndex !== -1 || bIndex !== -1) {
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    }
    return a.name.localeCompare(b.name);
  });
}

function resolveLanguage() {
  const preference = readSetting(SETTING.language, LANGUAGE_AUTO);
  if (preference !== LANGUAGE_AUTO && isSupportedLanguage(preference)) return preference;
  return mapComfyLocale(readSetting(COMFY_LOCALE_SETTING, FALLBACK_LANGUAGE));
}

// Recency window: whether "Used" is limited to the last N days, and N.
function readRecency() {
  const days = Number(readSetting(SETTING.recencyDays, DEFAULT_RECENCY_DAYS));
  return {
    enabled: readSetting(SETTING.recencyEnabled, true) !== false,
    days: Number.isFinite(days) && days > 0 ? days : DEFAULT_RECENCY_DAYS,
  };
}

function legacyMenuInUse() {
  const mode = readSetting(COMFY_MENU_SETTING, undefined);
  return mode === undefined || mode === "Disabled";
}

function currentSettings() {
  const appearancePreference = normalizeAppearancePreference(readSetting(SETTING.appearance, undefined));
  return {
    sizeUnit: readChoice(SETTING.sizeUnit, SIZE_UNITS, "binary"),
    density: readChoice(SETTING.density, DENSITIES, "normal"),
    dateFormat: readChoice(SETTING.dateFormat, DATE_FORMATS, "system"),
    defaultTab: readChoice(SETTING.defaultTab, DATA_TABS, "used"),
    defaultSection: readChoice(SETTING.defaultSection, ["models", "customNodes"], "models"),
    customNodeTrackingEnabled: readSetting(SETTING.customNodeTrackingEnabled, true) !== false,
    customNodeScanWorkflows: readSetting(SETTING.customNodeScanWorkflows, true) !== false,
    // The banner is visible by default. Only an explicit X dismissal hides it;
    // old versions of the visible on/off toggle are deliberately ignored.
    starBanner: readSetting(SETTING.starBannerDismissed, false) !== true,
    appearancePreference,
    appearance: getAppearanceMode(appearancePreference),
    paletteId: getAppearancePaletteId(appearancePreference),
    customAppearance: String(readSetting(SETTING.customAppearance, "") ?? ""),
  };
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
    this.activeSection = "models";
    this.activeTab = "used";
    this.activeCustomNodeTab = "used";
    // Keep the last package snapshot across modal opens. The backend checks
    // file/registry fingerprints and rebuilds only when an input changed.
    this.customNodeData = null;
    this.customNodeError = null;
    this.customNodeRequestId = 0;
    this.customNodeETag = null;
    this.lastCustomNodeSettingsSyncKey = null;
    this.customNodeSettingsSyncPromise = null;
    this.sortState = {
      used: { col: "last_activity", dir: -1 },
      unused: { col: "size_bytes", dir: -1 },
      disabled: { col: "size_bytes", dir: -1 },
      customUsed: { col: "execution_count", dir: -1 },
      customUnused: { col: "name", dir: 1 },
      customDisabled: { col: "name", dir: 1 },
      customWorkflow: { col: "name", dir: 1 },
    };
    this.selectedWorkflow = null;
    this.overlay = null;
    this.usedThresholdDays = DEFAULT_RECENCY_DAYS;
    this.custom = { colors: {} };
    this.paletteSnapshot = null;
    this.openAppearancePanel = null;
    this.executionRefreshTimer = null;
    this.tableLayoutCache = {};
    this.usageSourceFilter = readChoice(SETTING.usageSource, ["all", ...USAGE_SOURCES], "all");
    this.sourceUsageData = null;
    this.sourceUsageLoading = false;
    this.sourceUsageError = null;
    this.sourceUsageRequestId = 0;
    this.modelInventoryPeriod = null;
    // Whether the "Used within last N days" window applies at all. When
    // off, any past load (or a workflow reference) counts as used.
    // Both values live in the ComfyUI settings (see loadSettings()).
    this.usedThresholdEnabled = true;
    this.loadSettings();
  }

  // Re-reads language + display settings. Called whenever the dashboard
  // opens or a setting changes, so "auto" always tracks ComfyUI.
  loadSettings() {
    this.tr = createTranslator(resolveLanguage());
    this.settings = currentSettings();
    this.custom = parseCustomAppearance(this.settings.customAppearance);
    if (this.openAppearancePanel === null) {
      this.openAppearancePanel = this.settings.appearance === "custom" ? "custom" : "themes";
    }
    const recency = readRecency();
    this.usedThresholdEnabled = recency.enabled;
    this.usedThresholdDays = recency.days;
    this.usageSourceFilter = readChoice(SETTING.usageSource, ["all", ...USAGE_SOURCES], "all");
  }

  t(key, params) {
    return this.tr.t(key, params);
  }

  h(key, params) {
    return this.tr.tHtml(key, params);
  }

  async open() {
    injectCss();
    if (this.overlay) this.close();
    this.loadSettings();
    this.resolvePaletteSnapshot();
    this.activeSection = this.settings.defaultSection;
    this.activeTab = this.settings.defaultTab;
    this.activeCustomNodeTab = "used";
    this.sourceUsageData = null;
    this.sourceUsageError = null;
    this.sourceUsageRequestId += 1;
    this.customNodeRequestId += 1;
    await this.syncCustomNodeSettings();
    this.buildModal();
    if (this.data || this.customNodeData) this.render();
    if (this.activeSection === "customNodes") {
      await Promise.all([
        this.refreshCustomNodes({ quiet: Boolean(this.customNodeData) }),
        this.refreshSourceUsage({ render: false }),
      ]);
      this.render();
    } else await this.refresh();
  }

  close() {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    if (this.executionRefreshTimer) {
      clearTimeout(this.executionRefreshTimer);
      this.executionRefreshTimer = null;
    }
  }

  // Called by the ComfyUI settings system when one of our settings
  // changes while the dashboard is open.
  onSettingsChanged() {
    const recency = { enabled: this.usedThresholdEnabled, days: this.usedThresholdDays };
    const previous = this.settings;
    const previousLanguage = this.tr.code;
    const previousUsageSource = this.usageSourceFilter;
    const previousCustomTracking = previous.customNodeTrackingEnabled;
    const previousWorkflowScan = previous.customNodeScanWorkflows;
    this.loadSettings();
    const usageSourceChanged = previousUsageSource !== this.usageSourceFilter;
    const customNodeSettingsChanged = previousCustomTracking !== this.settings.customNodeTrackingEnabled
      || previousWorkflowScan !== this.settings.customNodeScanWorkflows;
    this.resolvePaletteSnapshot();
    this.usedThresholdEnabled = recency.enabled;
    this.usedThresholdDays = recency.days;
    if (!this.overlay) {
      // ComfyUI settings can be changed outside the dashboard. Synchronize
      // tracking switches even while the dashboard itself is closed.
      if (customNodeSettingsChanged) void this.syncCustomNodeSettings();
      return;
    }

    if (this.tr.code !== previousLanguage || this.settings.starBanner !== previous.starBanner) {
      this.close();
      this.buildModal();
      if (this.data) this.render();
      return;
    }

    this.applyLiveSettings();
    const changed = ["appearancePreference", "paletteId", "sizeUnit", "dateFormat", "density"].some((key) => previous[key] !== this.settings[key]);
    if (changed) this.render();
    if (usageSourceChanged && this.overlay) {
      const sourceSelect = this.overlay.querySelector(".ma-source-filter-select");
      if (sourceSelect) sourceSelect.value = this.usageSourceFilter;
      this.sourceUsageData = null;
      this.refreshSourceUsage();
    }
    if (customNodeSettingsChanged) {
      this.customNodeData = null;
      this.customNodeETag = null;
      void this.syncCustomNodeSettings().then(() => {
        if (this.activeSection === "customNodes") return this.refreshCustomNodes();
        return null;
      });
    }
  }

  applyLiveSettings() {
    const modal = this.overlay?.querySelector(".ma-modal");
    modal?.classList.toggle("ma-density-compact", this.settings.density === "compact");
    if (this.overlay) applyAppearance(this.overlay, this.settings.appearance, this.custom, this.paletteSnapshot);
  }

  scheduleExecutionRefresh() {
    if (!this.overlay) return;
    if (this.executionRefreshTimer) clearTimeout(this.executionRefreshTimer);
    this.executionRefreshTimer = setTimeout(() => {
      this.executionRefreshTimer = null;
      if (this.overlay) {
        if (this.activeSection === "customNodes") {
          Promise.all([
            this.refreshCustomNodes({ quiet: true }),
            this.refreshSourceUsage({ render: false }),
          ]).then(() => this.render());
        }
        else if (this.activeSection === "models") this.refresh({ quiet: true });
      }
    }, 450);
  }

  // Applies a new recency window (from the header, the Settings tab or
  // ComfyUI's own settings dialog) and reloads the data. Does nothing if
  // the dashboard already uses these values, so a change that arrives
  // through several paths only triggers one reload.
  async applyRecency(enabled, days) {
    if (enabled === this.usedThresholdEnabled && days === this.usedThresholdDays) return;
    this.usedThresholdEnabled = enabled;
    this.usedThresholdDays = days;
    if (!this.overlay) return;
    const toggle = this.overlay.querySelector(".ma-stale-toggle");
    const input = this.overlay.querySelector(".ma-stale-input");
    if (toggle) toggle.checked = enabled;
    if (input) {
      input.value = String(days);
      input.disabled = !enabled;
    }
    const settingsRoot = this.overlay.querySelector(".ma-body");
    const settingsDays = settingsRoot?.querySelector(`[data-setting="${SETTING.recencyDays}"]`);
    if (settingsDays) settingsDays.disabled = !enabled;
    this.modelInventoryPeriod = null;
    if (this.activeSection === "models") {
      const body = this.overlay.querySelector(".ma-body");
      body.innerHTML = `<div class="ma-summary">${this.h("common.loading")}</div>`;
      await this.refresh();
    } else {
      // The same recency selector drives package prompt-presence analytics.
      // Do not reload the model inventory while Custom Nodes is active.
      const body = this.overlay.querySelector(".ma-body");
      if (this.activeSection === "customNodes") {
        body.innerHTML = `<div class="ma-summary">${this.h("common.loading")}</div>`;
      }
      await this.refreshSourceUsage({ render: false });
      if (this.activeSection === "customNodes") this.render();
    }
  }

  // Called when a recency setting changed outside the dashboard.
  onRecencyChanged() {
    const recency = readRecency();
    return this.applyRecency(recency.enabled, recency.days);
  }

  buildModal() {
    const overlay = document.createElement("div");
    overlay.className = "ma-overlay ma-scope";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const showBanner = this.settings.starBanner;
    const densityClass = this.settings.density === "compact" ? " ma-density-compact" : "";
    const sourceOptions = [
      { value: "all", label: this.t("usage.source.all") },
      ...USAGE_SOURCES.map((source) => ({ value: source, label: this.t(`usage.source.${source}`) })),
    ];
    overlay.innerHTML = `
      <div class="ma-modal${densityClass}${showBanner ? " ma-modal--banner" : ""}" role="dialog" aria-modal="true" aria-label="${this.h("app.title")}">
        <div class="ma-header">
          <h2 class="ma-title"><i class="pi pi-chart-bar" aria-hidden="true"></i>${this.h("app.title")}</h2>
          <div class="ma-header-right">
            <div class="ma-shared-usage-controls">
              <label class="ma-stale-control" title="${this.h("header.recency.tooltip")}">
                <input type="checkbox" class="ma-stale-toggle" ${this.usedThresholdEnabled ? "checked" : ""} />
                ${this.h("header.recency.before")}
                <input type="number" class="ma-stale-input" min="1" step="1" value="${escapeHtml(this.usedThresholdDays)}" ${this.usedThresholdEnabled ? "" : "disabled"} />
                ${this.h("header.recency.after")}
              </label>
              <label class="ma-source-control" title="${this.h("header.source.tooltip")}">
                <span>${this.h("header.source.label")}</span>
                <select class="ma-source-filter-select" aria-label="${this.h("header.source.label")}">
                  ${sourceOptions.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === this.usageSourceFilter ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
                </select>
              </label>
            </div>
            <a class="ma-btn ma-btn-accent ma-star-btn ma-star-header" href="${GITHUB_REPO_URL}" target="_blank" rel="noopener noreferrer" title="${this.h("star.tooltip")}">${this.h("star.button")}</a>
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
          ${TABS.map((section) => `<button type="button" role="tab" class="ma-tab-btn" data-section="${section}">${this.h(`section.${section}`)}<span class="ma-tab-count" hidden></span></button>`).join("")}
        </div>
        <div class="ma-body">
          <div class="ma-summary">${this.h("common.loading")}</div>
        </div>
      </div>
    `;

    const bannerDismiss = overlay.querySelector(".ma-star-banner-dismiss");
    if (bannerDismiss) {
      bannerDismiss.addEventListener("click", async () => {
        // Hide it immediately, then persist the dismissal in ComfyUI settings.
        this.settings.starBanner = false;
        overlay.querySelector(".ma-star-banner")?.remove();
        overlay.querySelector(".ma-modal")?.classList.remove("ma-modal--banner");
        await writeSetting(SETTING.starBannerDismissed, true);
      });
    }

    overlay.querySelector(".ma-close-btn").addEventListener("click", () => this.close());
    overlay.querySelectorAll(".ma-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const section = btn.dataset.section;
        if (!TABS.includes(section) || section === this.activeSection) return;
        this.activeSection = section;
        this.render();
        const requestedPeriod = this.usedThresholdEnabled ? `${this.usedThresholdDays}d` : "all";
        if (section === "models" && (!this.data || this.modelInventoryPeriod !== requestedPeriod)) this.refresh();
        if (section === "customNodes") this.refreshCustomNodes({ quiet: Boolean(this.customNodeData) });
      });
    });
    const body = overlay.querySelector(".ma-body");
    this.attachSettingsHandlers(body);
    this.attachAppearanceHandlers(body);

    const staleInput = overlay.querySelector(".ma-stale-input");
    staleInput.addEventListener("change", async () => {
      const val = parseFloat(staleInput.value);
      if (!Number.isFinite(val) || val <= 0) {
        staleInput.value = String(this.usedThresholdDays);
        return;
      }
      // Persist in ComfyUI's settings first; applyRecency() is a no-op when
      // the settings onChange callback already applied the value.
      await writeSetting(SETTING.recencyDays, val);
      await this.applyRecency(this.usedThresholdEnabled, val);
    });

    const staleToggle = overlay.querySelector(".ma-stale-toggle");
    staleToggle.addEventListener("change", async () => {
      const enabled = staleToggle.checked;
      await writeSetting(SETTING.recencyEnabled, enabled);
      await this.applyRecency(enabled, this.usedThresholdDays);
    });

    const sourceSelect = overlay.querySelector(".ma-source-filter-select");
    sourceSelect.addEventListener("change", async () => {
      const nextSource = sourceSelect.value;
      if (!["all", ...USAGE_SOURCES].includes(nextSource) || nextSource === this.usageSourceFilter) return;
      this.usageSourceFilter = nextSource;
      this.sourceUsageData = null;
      this.sourceUsageError = null;
      await writeSetting(SETTING.usageSource, nextSource);
      this.sourceUsageLoading = true;
      this.render();
      await this.refreshSourceUsage();
    });

    document.body.appendChild(overlay);
    this.overlay = overlay;
    applyAppearance(overlay, this.settings.appearance, this.custom, this.paletteSnapshot);
  }

  async refresh({ quiet = false } = {}) {
    try {
      const thresholdParam = this.usedThresholdEnabled ? this.usedThresholdDays : "off";
      const res = await fetch(`/model_analytics/inventory?used_threshold_days=${encodeURIComponent(thresholdParam)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json();
      this.modelInventoryPeriod = thresholdParam === "off" ? "all" : `${thresholdParam}d`;
      await this.refreshSourceUsage({ render: false });
    } catch (e) {
      const body = this.overlay?.querySelector(".ma-body");
      if (body && !quiet) {
        body.innerHTML = `<div class="ma-empty-state">${this.h("common.loadError", { message: e.message })}</div>`;
      }
      return;
    }
    this.render({ preserveSettings: quiet && this.activeSection === "settings" });
  }

  async syncCustomNodeSettings() {
    const readPayload = () => ({
      tracking_enabled: this.settings?.customNodeTrackingEnabled !== false,
      scan_workflows: this.settings?.customNodeScanWorkflows !== false,
    });
    let payload = readPayload();
    let syncKey = JSON.stringify(payload);
    if (this.lastCustomNodeSettingsSyncKey === syncKey) return true;

    // Coalesce calls from the dashboard control and ComfyUI's onChange hook.
    // If the setting changes while a request is in flight, send only the
    // latest value after the current request has completed.
    if (this.customNodeSettingsSyncPromise) {
      await this.customNodeSettingsSyncPromise;
      payload = readPayload();
      syncKey = JSON.stringify(payload);
      if (this.lastCustomNodeSettingsSyncKey === syncKey) return true;
    }

    const request = (async () => {
      try {
        const response = await fetch("/model_analytics/custom_nodes/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (result?.success !== true) throw new Error(result?.error || "Invalid settings response");
        this.lastCustomNodeSettingsSyncKey = syncKey;
        return true;
      } catch (error) {
        console.warn("Custom Node Analytics settings could not be synchronized:", error);
        return false;
      }
    })();
    this.customNodeSettingsSyncPromise = request;
    try {
      return await request;
    } finally {
      if (this.customNodeSettingsSyncPromise === request) this.customNodeSettingsSyncPromise = null;
    }
  }

  async refreshCustomNodes({ quiet = false } = {}) {
    const requestId = ++this.customNodeRequestId;
    try {
      const headers = this.customNodeETag ? { "If-None-Match": this.customNodeETag } : {};
      const response = await fetch("/model_analytics/custom_nodes", { cache: "no-store", headers });
      if (response.status === 304) {
        if (!this.customNodeData) throw new Error("Server reported an unchanged snapshot before the first data load");
        this.customNodeError = null;
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (requestId !== this.customNodeRequestId) return;
      if (!payload || payload.success !== true || !Array.isArray(payload.packages) || !Array.isArray(payload.workflows)) {
        throw new Error(payload?.error || "Invalid package-level custom-node inventory response");
      }
      this.customNodeData = payload;
      this.customNodeETag = response.headers.get("ETag") || null;
      this.customNodeError = null;
    } catch (error) {
      if (requestId === this.customNodeRequestId) {
        this.customNodeError = error?.message || String(error);
        // Retain the last known-good snapshot on transient API failures. A
        // cached view is more useful than replacing it with a loading/error
        // page every time the dashboard is reopened.
        if (!quiet && !this.customNodeData) this.customNodeData = null;
      }
    }
    if (this.overlay && this.activeSection === "customNodes") this.render();
  }

  async refreshSourceUsage({ render = true } = {}) {
    const requestId = ++this.sourceUsageRequestId;
    const period = this.usedThresholdEnabled ? `${this.usedThresholdDays}d` : "all";
    this.sourceUsageLoading = true;
    this.sourceUsageError = null;
    try {
      const response = await fetch(`/model_analytics/usage?period=${encodeURIComponent(period)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (requestId !== this.sourceUsageRequestId) return;
      if (!data || data.success !== true || !Array.isArray(data.models) || !Array.isArray(data.custom_packages)) {
        throw new Error(data?.error || "Invalid usage response");
      }
      this.sourceUsageData = data;
    } catch (error) {
      if (requestId === this.sourceUsageRequestId) {
        this.sourceUsageData = null;
        this.sourceUsageError = error?.message || String(error);
      }
    } finally {
      if (requestId === this.sourceUsageRequestId) this.sourceUsageLoading = false;
    }
    if (render && this.overlay) this.render();
  }

  sourceFilteredInventory() {
    if (this.usageSourceFilter === "all" || !this.sourceUsageData) return null;
    const models = this.data?.models || [];
    return {
      used: findUsedInventoryModels(models, this.sourceUsageData.models, this.usageSourceFilter),
      unused: findUnusedInventoryModels(models, this.sourceUsageData.models, this.usageSourceFilter),
    };
  }

  tabCounts() {
    if (!this.data) return {};
    const stats = calculateInventoryStats(this.data.models || []);
    const filtered = this.sourceFilteredInventory();
    return {
      used: this.usageSourceFilter === "all" ? stats.used.length : (filtered?.used.length),
      unused: this.usageSourceFilter === "all" ? stats.unused.length : (filtered?.unused.length),
      disabled: stats.disabled.length,
      workflow: (this.data.workflow_names || []).length,
    };
  }

  sectionCounts() {
    return {
      models: this.data ? Number(this.data.total_models || 0) : undefined,
      customNodes: this.customNodeData ? Number(this.customNodeData.summary?.package_count || 0) : undefined,
    };
  }

  render({ preserveSettings = false } = {}) {
    if (!this.overlay) return;
    const modelCounts = this.tabCounts();
    const sectionCounts = this.sectionCounts();
    this.overlay.querySelectorAll(".ma-tab-btn").forEach((btn) => {
      const active = btn.dataset.section === this.activeSection;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      const badge = btn.querySelector(".ma-tab-count");
      const count = sectionCounts[btn.dataset.section];
      if (badge) {
        badge.hidden = count === undefined;
        if (count !== undefined) badge.textContent = String(count);
      }
    });

    const sharedUsageControls = this.overlay.querySelector(".ma-shared-usage-controls");
    if (sharedUsageControls) {
      sharedUsageControls.hidden = !["models", "customNodes"].includes(this.activeSection);
    }

    const body = this.overlay.querySelector(".ma-body");
    if (preserveSettings && this.activeSection === "settings") return;
    if (this.activeSection === "settings") {
      body.classList.add("ma-body-settings");
      body.innerHTML = this.renderSettingsTab();
      return;
    }
    body.classList.remove("ma-body-settings");

    if (this.activeSection === "models") {
      const tabs = DATA_TABS.map((tab) => {
        const count = modelCounts[tab];
        return `<button type="button" role="tab" class="ma-subtab-btn${tab === this.activeTab ? " active" : ""}" data-model-tab="${tab}" aria-selected="${tab === this.activeTab ? "true" : "false"}">${this.h(`tab.${tab}`)}${count === undefined ? "" : `<span class="ma-tab-count">${escapeHtml(count)}</span>`}</button>`;
      }).join("");
      let content = `<div class="ma-empty-state">${this.h("common.noData")}</div>`;
      if (this.data) {
        if (this.activeTab === "used") content = this.renderUsedTab();
        else if (this.activeTab === "unused") content = this.renderUnusedTab();
        else if (this.activeTab === "disabled") content = this.renderDisabledTab();
        else content = this.renderWorkflowTab();
      }
      body.innerHTML = `<div class="ma-subtabs" role="tablist">${tabs}</div><div class="ma-section-content">${content}</div>`;
      body.querySelectorAll(".ma-subtab-btn[data-model-tab]").forEach((button) => {
        button.addEventListener("click", () => {
          this.activeTab = button.dataset.modelTab;
          this.render();
        });
      });
      this.attachSortHandlers(body);
      this.attachWorkflowSelectHandler(body);
      return;
    }

    if (this.activeSection === "customNodes") {
      body.innerHTML = this.renderCustomNodeSection();
      body.querySelectorAll(".ma-subtab-btn[data-custom-node-tab]").forEach((button) => {
        button.addEventListener("click", () => {
          this.activeCustomNodeTab = button.dataset.customNodeTab;
          this.render();
        });
      });
      this.attachSortHandlers(body);
      return;
    }
  }

  renderCustomNodeSection() {
    const tabs = renderCustomNodeTabs({
      data: this.customNodeData,
      usageData: this.sourceUsageData,
      source: this.usageSourceFilter,
      activeTab: this.activeCustomNodeTab,
      h: (key, params) => this.h(key, params),
    });
    if (this.customNodeError && !this.customNodeData) {
      return `${tabs}<div class="ma-section-content"><div class="ma-empty-state">${this.h("common.loadError", { message: this.customNodeError })}</div></div>`;
    }
    if (!this.customNodeData) {
      return `${tabs}<div class="ma-section-content"><div class="ma-summary">${this.h("common.loading")}</div></div>`;
    }
    if (this.customNodeData.success !== true) {
      return `${tabs}<div class="ma-section-content"><div class="ma-empty-state">${this.h("common.loadError", { message: this.customNodeData.error || "Unknown error" })}</div></div>`;
    }

    const data = this.customNodeData;
    const packages = Array.isArray(data.packages) ? data.packages : [];
    const workflows = Array.isArray(data.workflows) ? data.workflows : [];
    const trackingEnabled = data.settings?.tracking_enabled !== false;
    const scanEnabled = data.settings?.scan_workflows !== false;
    if (["used", "unused"].includes(this.activeCustomNodeTab)) {
      if (this.sourceUsageData?.custom_node_usage_available === false) {
        return `${tabs}<div class="ma-section-content"><div class="ma-empty-state ma-source-filter-error">${this.h("usage.filter.error", { message: "Custom Node usage analytics are currently unavailable." })}</div></div>`;
      }
      if (this.sourceUsageLoading && !this.sourceUsageData) {
        return `${tabs}<div class="ma-section-content"><div class="ma-empty-state"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> ${this.h("usage.filter.loading")}</div></div>`;
      }
      if (this.sourceUsageError && !this.sourceUsageData) {
        return `${tabs}<div class="ma-section-content"><div class="ma-empty-state ma-source-filter-error">${this.h("usage.filter.error", { message: this.sourceUsageError })}</div></div>`;
      }
    }
    const packageUsage = this.sourceUsageData?.custom_packages || [];
    const source = this.usageSourceFilter;
    const period = this.sourceUsageData?.period || (this.usedThresholdEnabled ? `${this.usedThresholdDays}d` : "all");
    const usedPackages = findUsedCustomNodePackages(packages, packageUsage, source, period);
    const unusedPackages = findUnusedCustomNodePackages(packages, packageUsage, source, period);
    const packageUsageById = new Map(packageUsage.map((item) => [item.package_id, item]));
    const selectedPromptCount = (items) => items.reduce((total, item) => {
      const stats = packageUsageById.get(item.id);
      if (!stats) return total;
      if (source === "all") return total + Number(stats.prompt_count || 0);
      return total + Number(stats.source_counts?.[source] || 0);
    }, 0);
    let content = "";

    if (this.activeCustomNodeTab === "used") {
      const rows = usedPackages;
      const sorted = this.sortRows(rows, this.sortState.customUsed.col, this.sortState.customUsed.dir);
      const variant = this.usedThresholdEnabled ? "window" : "all";
      const params = {
        count: bold(sorted.length),
        executions: bold(sorted.reduce((sum, item) => sum + Number(item.execution_count || 0), 0)),
        prompts: bold(selectedPromptCount(sorted)),
        days: this.usedThresholdDays,
        source: this.t(`usage.source.${source}`),
      };
      const summaryKey = source === "all" ? `custom.used.summary.${variant}` : `custom.used.summary.source.${variant}`;
      content = sorted.length
        ? `<div class="ma-summary">${this.h(summaryKey, params)}${!trackingEnabled ? ` · ${this.h("custom.status.trackingPaused")}` : ""}</div>${this.renderDataTable("customUsed", sorted)}`
        : `<div class="ma-empty-state">${this.h(source === "all" ? `custom.empty.used.${variant}` : "custom.empty.used.source", params)}</div>`;
    } else if (this.activeCustomNodeTab === "unused") {
      const rows = unusedPackages;
      const sorted = this.sortRows(rows, this.sortState.customUnused.col, this.sortState.customUnused.dir);
      const variant = this.usedThresholdEnabled ? "window" : "all";
      const params = { count: bold(sorted.length), days: this.usedThresholdDays, source: this.t(`usage.source.${source}`) };
      const summaryKey = source === "all" ? `custom.unused.summary.${variant}` : `custom.unused.summary.source.${variant}`;
      content = sorted.length
        ? `<div class="ma-summary">${this.h(summaryKey, params)} ${this.h("custom.unused.note")}${!trackingEnabled ? ` · ${this.h("custom.status.trackingPaused")}` : ""}</div>${this.renderDataTable("customUnused", sorted)}`
        : `<div class="ma-empty-state">${this.h(source === "all" ? `custom.empty.unused.${variant}` : "custom.empty.unused.source", params)}</div>`;
    } else if (this.activeCustomNodeTab === "disabled") {
      const rows = packages.filter((item) => item.disabled === true);
      const sorted = this.sortRows(rows, this.sortState.customDisabled.col, this.sortState.customDisabled.dir);
      content = sorted.length
        ? `<div class="ma-summary">${this.h("custom.disabled.summary", { count: bold(sorted.length) })}</div>${this.renderDataTable("customDisabled", sorted)}`
        : `<div class="ma-empty-state">${this.h("custom.empty.disabled")}</div>`;
    } else {
      const workflowInfo = data.workflow_scan || {};
      if (!scanEnabled) {
        content = `<div class="ma-empty-state">${this.h("custom.workflow.scanDisabled")}</div>`;
      } else if (workflowInfo.available === false) {
        content = `<div class="ma-empty-state">${this.h("custom.workflow.scanUnavailable")}</div>`;
      } else {
        const sorted = this.sortRows(workflows, this.sortState.customWorkflow.col, this.sortState.customWorkflow.dir);
        content = sorted.length
          ? `<div class="ma-summary">${this.h("custom.workflow.summary", { count: bold(sorted.length) })}</div>${this.renderDataTable("customWorkflow", sorted)}`
          : `<div class="ma-empty-state">${this.h("custom.empty.workflow")}</div>`;
      }
    }
    return `${tabs}<div class="ma-section-content"><section class="ma-section">${content}</section></div>`;
  }

  optionsHtml(options, value) {
    return (Array.isArray(options) ? options : []).map((option) => {
      const optionValue = String(option.value ?? "");
      const selected = optionValue === String(value) ? " selected" : "";
      return `<option value="${escapeHtml(optionValue)}"${selected}>${escapeHtml(option.text ?? optionValue)}</option>`;
    }).join("");
  }

  renderSettingSelect(id, titleKey, tooltipKey, value) {
    let options = [];
    if (id === SETTING.language) {
      options = [
        { value: LANGUAGE_AUTO, text: this.t("settings.language.auto") },
        ...LANGUAGES.map((language) => ({ value: language.code, text: language.label })),
      ];
    } else if (id === SETTING.density) {
      options = [
        { value: "normal", text: this.t("settings.density.normal") },
        { value: "compact", text: this.t("settings.density.compact") },
      ];
    } else if (id === SETTING.sizeUnit) {
      options = [
        { value: "binary", text: this.t("settings.sizeUnit.binary") },
        { value: "decimal", text: this.t("settings.sizeUnit.decimal") },
      ];
    } else if (id === SETTING.dateFormat) {
      options = [
        { value: "system", text: this.t("settings.dateFormat.system") },
        { value: "iso", text: this.t("settings.dateFormat.iso") },
      ];
    } else if (id === SETTING.defaultTab) {
      options = DATA_TABS.map((tab) => ({ value: tab, text: this.t(`tab.${tab}`) }));
    } else if (id === SETTING.defaultSection) {
      options = [
        { value: "models", text: this.t("section.models") },
        { value: "customNodes", text: this.t("section.customNodes") },
      ];
    }

    return `
      <label class="ma-setting-row">
        <span class="ma-setting-copy">
          <span class="ma-setting-title">${this.h(titleKey)}</span>
          <span class="ma-setting-description">${this.h(tooltipKey)}</span>
        </span>
        <select class="ma-select ma-settings-select" data-setting="${escapeHtml(id)}" aria-label="${this.h(titleKey)}">
          ${this.optionsHtml(options, value)}
        </select>
      </label>
    `;
  }

  renderSettingToggle(id, titleKey, tooltipKey, checked) {
    return `
      <label class="ma-setting-row ma-setting-toggle-row">
        <span class="ma-setting-copy">
          <span class="ma-setting-title">${this.h(titleKey)}</span>
          <span class="ma-setting-description">${this.h(tooltipKey)}</span>
        </span>
        <input class="ma-settings-checkbox" type="checkbox" data-setting="${escapeHtml(id)}" ${checked ? "checked" : ""} aria-label="${this.h(titleKey)}" />
      </label>
    `;
  }

  renderSettingNumber(id, titleKey, tooltipKey, value, disabled) {
    return `
      <label class="ma-setting-row">
        <span class="ma-setting-copy">
          <span class="ma-setting-title">${this.h(titleKey)}</span>
          <span class="ma-setting-description">${this.h(tooltipKey)}</span>
        </span>
        <input class="ma-settings-number" type="number" min="1" step="1" data-setting="${escapeHtml(id)}" value="${escapeHtml(value)}" ${disabled ? "disabled" : ""} aria-label="${this.h(titleKey)}" />
      </label>
    `;
  }

  renderAppearanceSettings() {
    const selectedId = this.settings.paletteId;
    const choices = getComfyPaletteChoices();
    const currentName = this.settings.appearance === "custom"
      ? this.t("settings.appearance.custom")
      : this.settings.appearance === "palette"
        ? (choices.find((item) => item.id === selectedId)?.name || selectedId)
        : this.t("settings.appearance.follow");
    const themeChoices = choices.map((palette) => `
      <button type="button" class="ma-theme-choice${this.settings.appearance === "palette" && selectedId === palette.id ? " is-selected" : ""}" data-ma-theme="${escapeHtml(palette.id)}" aria-pressed="${this.settings.appearance === "palette" && selectedId === palette.id ? "true" : "false"}">
        <span class="ma-theme-swatch" aria-hidden="true"></span>
        <span class="ma-theme-choice-label">${escapeHtml(palette.name)}</span>
        ${this.settings.appearance === "palette" && selectedId === palette.id ? '<i class="pi pi-check" aria-hidden="true"></i>' : ""}
      </button>
    `).join("");
    const themesExpanded = this.openAppearancePanel === "themes";
    const customExpanded = this.openAppearancePanel === "custom";
    return `
      <div class="ma-appearance-stack">
        <section class="ma-appearance-card${themesExpanded ? " is-open" : ""}">
          <button type="button" class="ma-appearance-disclosure" data-ma-appearance-toggle="themes" aria-expanded="${themesExpanded}">
            <span class="ma-appearance-leading"><i class="pi pi-palette" aria-hidden="true"></i></span>
            <span class="ma-appearance-copy">
              <span class="ma-appearance-title">${this.h("settings.appearance.themes")}</span>
              <span class="ma-appearance-subtitle">${escapeHtml(currentName)}</span>
            </span>
            <i class="pi ${themesExpanded ? "pi-chevron-up" : "pi-chevron-down"} ma-appearance-chevron" aria-hidden="true"></i>
          </button>
          <div class="ma-theme-panel" ${themesExpanded ? "" : "hidden"}>
            <button type="button" class="ma-theme-choice ma-theme-follow${this.settings.appearance === "follow" ? " is-selected" : ""}" data-ma-theme="follow" aria-pressed="${this.settings.appearance === "follow" ? "true" : "false"}">
              <span class="ma-theme-follow-icon"><i class="pi pi-desktop" aria-hidden="true"></i></span>
              <span class="ma-theme-choice-copy"><span class="ma-theme-choice-label">${this.h("settings.appearance.follow")}</span><span class="ma-theme-choice-hint">${this.h("settings.appearance.followHint")}</span></span>
              ${this.settings.appearance === "follow" ? '<i class="pi pi-check" aria-hidden="true"></i>' : ""}
            </button>
            <div class="ma-theme-grid">${themeChoices}</div>
          </div>
        </section>
        <section class="ma-appearance-card${customExpanded ? " is-open" : ""}">
          <button type="button" class="ma-appearance-disclosure" data-ma-appearance-toggle="custom" aria-expanded="${customExpanded}">
            <span class="ma-appearance-leading"><i class="pi pi-sliders-h" aria-hidden="true"></i></span>
            <span class="ma-appearance-copy">
              <span class="ma-appearance-title">${this.h("settings.appearance.custom")}</span>
              <span class="ma-appearance-subtitle">${this.h("settings.appearance.customHint")}</span>
            </span>
            <i class="pi ${customExpanded ? "pi-chevron-up" : "pi-chevron-down"} ma-appearance-chevron" aria-hidden="true"></i>
          </button>
          <div class="ma-custom-panel" ${customExpanded ? "" : "hidden"}>
            ${this.renderCustomAppearance()}
          </div>
        </section>
      </div>
    `;
  }

  // The optional editor for advanced users. Unset colours inherit from the
  // active ComfyUI palette; overrides remain scoped to Model Analytics.
  renderCustomAppearance() {
    const colors = this.custom.colors;
    const tokens = COLOR_TOKENS.map((token) => {
      const stored = colors[token.id];
      const hex = stored || (this.overlay ? effectiveTokenHex(this.overlay, token.id) : "#000000");
      const label = this.h(token.labelKey);
      return `
        <div class="ma-token" data-token-row="${token.id}">
          <span class="ma-token-label">${label}</span>
          <span class="ma-token-value" data-set="${stored ? "true" : "false"}">${stored ? escapeHtml(stored) : this.h("settings.custom.inherited")}</span>
          <input class="ma-color" type="color" data-ma-token="${token.id}" value="${escapeHtml(hex)}" aria-label="${label}" />
          <button type="button" class="ma-btn ma-btn--ghost ma-btn--icon" data-ma-reset-token="${token.id}" title="${this.h("settings.custom.resetValue")}" aria-label="${this.h("settings.custom.resetValue")}" ${stored ? "" : "disabled"}><i class="pi pi-undo" aria-hidden="true"></i></button>
        </div>
      `;
    }).join("");

    const radius = `<input class="ma-input" type="number" min="${RADIUS_RANGE.min}" max="${RADIUS_RANGE.max}" step="1" data-ma-custom="radius" value="${this.custom.radius ?? ""}" placeholder="${RADIUS_RANGE.fallback}" aria-label="${this.h("settings.custom.radius")}" />`;
    const fontSize = `<input class="ma-input" type="number" min="${FONT_SIZE_RANGE.min}" max="${FONT_SIZE_RANGE.max}" step="1" data-ma-custom="fontSize" value="${this.custom.fontSize ?? ""}" placeholder="${FONT_SIZE_RANGE.fallback}" aria-label="${this.h("settings.custom.fontSize")}" />`;
    const schemeOptions = SCHEMES.map((scheme) => ({ value: scheme, text: this.t(`settings.custom.scheme.${scheme}`) }));
    const scheme = `<select class="ma-select" data-ma-custom="scheme" aria-label="${this.h("settings.custom.scheme.name")}">${this.optionsHtml(schemeOptions, this.custom.scheme || "inherit")}</select>`;

    return `
      <section class="ma-section">
        <h3 class="ma-section-title">${this.h("settings.custom.group")}</h3>
        <p class="ma-section-note">${this.h("settings.custom.note")}</p>
        <div class="ma-tokens">${tokens}</div>
        ${this.customAppearanceRow("settings.custom.radius", "", radius)}
        ${this.customAppearanceRow("settings.custom.fontSize", "", fontSize)}
        ${this.customAppearanceRow("settings.custom.scheme.name", "settings.custom.scheme.hint", scheme)}
        <div class="ma-actions">
          <button type="button" class="ma-btn" data-ma-reset-all>${this.h("settings.custom.resetAll")}</button>
        </div>
      </section>
    `;
  }

  customAppearanceRow(titleKey, hintKey, controlHtml) {
    return `
      <label class="ma-custom-row">
        <span class="ma-custom-row-copy">
          <span class="ma-custom-row-title">${this.h(titleKey)}</span>
          ${hintKey ? `<span class="ma-custom-row-hint">${this.h(hintKey)}</span>` : ""}
        </span>
        ${controlHtml}
      </label>
    `;
  }

  renderSettingsTab() {
    const language = readChoice(SETTING.language, [LANGUAGE_AUTO, ...LANGUAGES.map((item) => item.code)], LANGUAGE_AUTO);
    return `
      <div class="ma-settings-page">
        <p class="ma-settings-intro">${this.h("settings.panel.description")}</p>
        <section class="ma-settings-section">
          <h3>${this.h("settings.group.general")}</h3>
          ${this.renderSettingSelect(SETTING.language, "settings.language.name", "settings.language.tooltip", language)}
          ${this.renderAppearanceSettings()}
          ${this.renderSettingSelect(SETTING.density, "settings.density.name", "settings.density.tooltip", this.settings.density)}
          ${this.renderSettingSelect(SETTING.dateFormat, "settings.dateFormat.name", "settings.dateFormat.tooltip", this.settings.dateFormat)}
          ${this.renderSettingSelect(SETTING.defaultSection, "settings.defaultSection.name", "settings.defaultSection.tooltip", this.settings.defaultSection)}
        </section>
        <section class="ma-settings-section">
          <h3>${this.h("settings.group.models")}</h3>
          <p class="ma-section-note">${this.h("settings.group.modelsNote")}</p>
          ${this.renderSettingToggle(SETTING.recencyEnabled, "settings.recency.enabled.name", "settings.recency.enabled.tooltip", this.usedThresholdEnabled)}
          ${this.renderSettingNumber(SETTING.recencyDays, "settings.recency.days.name", "settings.recency.days.tooltip", this.usedThresholdDays, !this.usedThresholdEnabled)}
          ${this.renderSettingSelect(SETTING.sizeUnit, "settings.sizeUnit.name", "settings.sizeUnit.tooltip", this.settings.sizeUnit)}
          ${this.renderSettingSelect(SETTING.defaultTab, "settings.defaultTab.name", "settings.defaultTab.tooltip", this.settings.defaultTab)}
        </section>
        <section class="ma-settings-section">
          <h3>${this.h("settings.group.customNodes")}</h3>
          <p class="ma-section-note">${this.h("settings.group.customNodesNote")}</p>
          ${this.renderSettingToggle(SETTING.customNodeTrackingEnabled, "settings.customNodes.tracking.name", "settings.customNodes.tracking.tooltip", this.settings.customNodeTrackingEnabled)}
          ${this.renderSettingToggle(SETTING.customNodeScanWorkflows, "settings.customNodes.scan.name", "settings.customNodes.scan.tooltip", this.settings.customNodeScanWorkflows)}
          <p class="ma-section-note">${this.h("settings.customNodes.storageNote")}</p>
        </section>
        <p class="ma-settings-feedback" role="status" aria-live="polite"></p>
      </div>
    `;
  }

  attachSettingsHandlers(root) {
    if (!root || root.dataset.maSettingsHandlers === "true") return;
    root.dataset.maSettingsHandlers = "true";
    const feedback = (message) => {
      const node = root.querySelector(".ma-settings-feedback");
      if (node) node.textContent = message;
    };
    const persist = async (control) => {
      const id = control.dataset.setting;
      const isCheckbox = control.type === "checkbox";
      const isNumber = control.type === "number";
      let value = isCheckbox ? control.checked : control.value;
      if (isNumber) {
        value = parseFloat(control.value);
        if (!Number.isFinite(value) || value <= 0) {
          control.value = String(readRecency().days);
          return;
        }
      }
      const previous = isNumber
        ? readRecency().days
        : readSetting(id, isCheckbox ? true : control.value);
      feedback("");
      const saved = await writeSetting(id, value);
      if (!saved) {
        if (isCheckbox) control.checked = previous !== false;
        else control.value = String(previous);
        feedback(this.t("settings.saveError"));
        return;
      }

      if (id === SETTING.recencyEnabled || id === SETTING.recencyDays) {
        await this.onRecencyChanged();
        return;
      }
      if (id === SETTING.customNodeTrackingEnabled || id === SETTING.customNodeScanWorkflows) {
        this.loadSettings();
        const synchronized = await this.syncCustomNodeSettings();
        if (!synchronized) feedback(this.t("settings.customNodes.syncError"));
        this.customNodeData = null;
        this.customNodeETag = null;
        if (this.activeSection === "customNodes") await this.refreshCustomNodes();
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

  // Handlers of the Custom appearance editor. Colour pickers preview live
  // while dragging ("input") and are stored once, when the picker commits
  // ("change"), so ComfyUI's settings are not written on every mouse move.
  setFeedback(message) {
    const node = this.overlay?.querySelector(".ma-settings-feedback");
    if (node) node.textContent = message;
  }

  attachAppearanceHandlers(root) {
    if (!root || root.dataset.maAppearanceHandlers === "true") return;
    root.dataset.maAppearanceHandlers = "true";

    root.addEventListener("input", (event) => {
      const picker = event.target?.closest?.("[data-ma-token]");
      if (picker && root.contains(picker)) this.previewToken(picker.dataset.maToken, picker.value);
    });

    root.addEventListener("change", async (event) => {
      const control = event.target?.closest?.("[data-ma-token], [data-ma-custom]");
      if (!control || !root.contains(control)) return;
      if (control.dataset.maToken) {
        this.previewToken(control.dataset.maToken, control.value);
      } else {
        this.updateCustomOption(control);
      }
      await this.saveCustom();
    });

    root.addEventListener("click", async (event) => {
      const toggle = event.target?.closest?.("[data-ma-appearance-toggle]");
      if (toggle && root.contains(toggle)) {
        const panel = toggle.dataset.maAppearanceToggle;
        this.openAppearancePanel = this.openAppearancePanel === panel ? null : panel;
        if (panel === "custom" && this.openAppearancePanel === "custom") {
          await this.saveAppearancePreference("custom");
        }
        this.render();
        return;
      }

      const themeChoice = event.target?.closest?.("[data-ma-theme]");
      if (themeChoice && root.contains(themeChoice)) {
        const id = themeChoice.dataset.maTheme;
        await this.saveAppearancePreference(id === "follow" ? "follow" : `palette:${id}`);
        this.openAppearancePanel = "themes";
        this.loadSettings();
        this.resolvePaletteSnapshot();
        this.render();
        this.applyLiveSettings();
        return;
      }

      const resetToken = event.target?.closest?.("[data-ma-reset-token]");
      const resetAll = event.target?.closest?.("[data-ma-reset-all]");
      if (!(resetToken || resetAll) || !root.contains(event.target)) return;
      if (resetAll) {
        this.custom = { colors: {} };
      } else {
        const { [resetToken.dataset.maResetToken]: _unset, ...rest } = this.custom.colors;
        this.custom.colors = rest;
      }
      applyAppearance(this.overlay, this.settings.appearance, this.custom, this.paletteSnapshot);
      this.render();
      await this.saveCustom();
    });
  }

  resolvePaletteSnapshot() {
    if (this.settings.appearance !== "palette" || !this.settings.paletteId) {
      this.paletteSnapshot = null;
      return;
    }
    const paletteStore = getComfyPaletteStore();
    const activeId = readSetting("Comfy.ColorPalette", "dark");
    this.paletteSnapshot = readComfyPaletteSnapshot(
      paletteStore,
      this.settings.paletteId,
      activeId,
      getCustomComfyPalettes(),
    );
    if (!this.paletteSnapshot) {
      this.setFeedback(this.t("settings.appearance.paletteUnavailable"));
    }
  }

  async saveAppearancePreference(preference) {
    this.setFeedback("");
    const saved = await writeSetting(SETTING.appearance, normalizeAppearancePreference(preference));
    if (!saved) this.setFeedback(this.t("settings.saveError"));
  }

  previewToken(id, value) {
    if (!HEX_COLOR.test(value) || !COLOR_TOKENS.some((token) => token.id === id)) return;
    this.custom.colors[id] = value.toLowerCase();
    applyAppearance(this.overlay, this.settings.appearance, this.custom, this.paletteSnapshot);
    const row = this.overlay?.querySelector(`[data-token-row="${id}"]`);
    if (!row) return;
    const label = row.querySelector(".ma-token-value");
    label.textContent = value.toLowerCase();
    label.dataset.set = "true";
    row.querySelector("[data-ma-reset-token]").disabled = false;
  }

  updateCustomOption(control) {
    const key = control.dataset.maCustom;
    if (key === "scheme") {
      this.custom.scheme = control.value === "inherit" ? undefined : control.value;
    } else {
      const range = key === "radius" ? RADIUS_RANGE : FONT_SIZE_RANGE;
      const number = parseFloat(control.value);
      if (Number.isFinite(number)) {
        this.custom[key] = Math.min(range.max, Math.max(range.min, Math.round(number)));
        control.value = String(this.custom[key]);
      } else {
        this.custom[key] = undefined;
        control.value = "";
      }
    }
    applyAppearance(this.overlay, this.settings.appearance, this.custom, this.paletteSnapshot);
  }

  async saveCustom() {
    this.setFeedback("");
    const saved = await writeSetting(SETTING.customAppearance, serializeCustomAppearance(this.custom));
    if (!saved) this.setFeedback(this.t("settings.saveError"));
  }

  size(bytes) {
    return formatBytes(bytes, this.settings.sizeUnit);
  }

  date(iso) {
    return formatDate(iso, this.settings.dateFormat);
  }

  packageNameCell(packageRow) {
    const name = escapeHtml(packageRow.name || "—");
    const path = escapeHtml(packageRow.relative_path || "");
    return `<span class="ma-table-primary">${name}</span>${path ? `<span class="ma-table-secondary">${path}</span>` : ""}`;
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

  tableColumnDefinitions(tableKey) {
    const definitions = {
      used: [
        { id: "rel_path", labelKey: "col.name", width: 30, minWidth: 150, sortable: true, render: (m) => escapeHtml(m.rel_path), title: (m) => m.rel_path },
        { id: "size_bytes", labelKey: "col.size", width: 9, minWidth: 68, sortable: true, render: (m) => this.size(m.size_bytes) },
        { id: "workflows", labelKey: "col.workflows", width: 18, minWidth: 105, sortable: true, render: (m) => m.workflows.length ? escapeHtml(m.workflows.join(", ")) : "—", title: (m) => m.workflows.join(", ") },
        { id: "used_reason", labelKey: "col.why", width: 16, minWidth: 100, sortable: true, render: (m) => this.usedReasonCell(m) },
        { id: "use_count", labelKey: "col.loads", width: 8, minWidth: 58, sortable: true, render: (m) => String(m.use_count) },
        { id: "queue_count", labelKey: "col.queued", width: 8, minWidth: 58, sortable: true, render: (m) => String(m.queue_count || 0) },
        { id: "last_activity", labelKey: "col.lastUsed", width: 11, minWidth: 102, sortable: true, render: (m) => escapeHtml(this.date(m.last_activity)) },
      ],
      unused: [
        { id: "rel_path", labelKey: "col.name", width: 48, minWidth: 150, sortable: true, render: (m) => escapeHtml(m.rel_path), title: (m) => m.rel_path },
        { id: "kind", labelKey: "col.category", width: 16, minWidth: 82, sortable: false, render: (m) => `<span class="ma-badge">${escapeHtml(m.kind)}</span>` },
        { id: "size_bytes", labelKey: "col.size", width: 16, minWidth: 76, sortable: true, render: (m) => this.size(m.size_bytes) },
        { id: "last_activity", labelKey: "col.lastUsed", width: 20, minWidth: 100, sortable: true, render: (m) => escapeHtml(this.date(m.last_activity)) },
      ],
      disabled: [
        { id: "rel_path", labelKey: "col.name", width: 58, minWidth: 165, sortable: true, render: (m) => escapeHtml(m.rel_path), title: (m) => m.rel_path },
        { id: "kind", labelKey: "col.category", width: 21, minWidth: 85, sortable: false, render: (m) => `<span class="ma-badge">${escapeHtml(m.kind)}</span>` },
        { id: "size_bytes", labelKey: "col.size", width: 21, minWidth: 78, sortable: true, render: (m) => this.size(m.size_bytes) },
      ],
      workflow: [
        { id: "rel_path", labelKey: "col.name", width: 48, minWidth: 145, sortable: false, render: (m) => escapeHtml(m.rel_path), title: (m) => m.rel_path },
        { id: "kind", labelKey: "col.category", width: 18, minWidth: 82, sortable: false, render: (m) => `<span class="ma-badge">${escapeHtml(m.kind)}</span>` },
        { id: "size_bytes", labelKey: "col.size", width: 17, minWidth: 72, sortable: false, render: (m) => this.size(m.size_bytes) },
        { id: "status", labelKey: "col.status", width: 17, minWidth: 78, sortable: false, render: () => `<span class="ma-badge ma-badge-used">${this.h("workflow.found")}</span>` },
      ],
      customUsed: [
        { id: "name", labelKey: "custom.col.package", width: 34, minWidth: 150, sortable: true, render: (p) => this.packageNameCell(p), title: (p) => p.relative_path || p.name },
        { id: "extension_type", labelKey: "custom.col.type", width: 15, minWidth: 105, sortable: true, render: (p) => `<span class="ma-badge">${this.h(`custom.type.${p.extension_type || "other"}`)}</span>` },
        { id: "registered_node_count", labelKey: "custom.col.nodeTypes", width: 13, minWidth: 82, sortable: true, render: (p) => String(Number(p.registered_node_count || 0)) },
        { id: "execution_count", labelKey: "custom.col.executions", width: 16, minWidth: 90, sortable: true, render: (p) => String(Number(p.execution_count || 0)) },
        { id: "workflow_count", labelKey: "custom.col.workflows", width: 14, minWidth: 82, sortable: true, render: (p) => String(Number(p.workflow_count || 0)) },
        { id: "last_executed", labelKey: "custom.col.lastUsed", width: 23, minWidth: 120, sortable: true, render: (p) => escapeHtml(this.date(p.last_executed)) },
      ],
      customUnused: [
        { id: "name", labelKey: "custom.col.package", width: 40, minWidth: 150, sortable: true, render: (p) => this.packageNameCell(p), title: (p) => p.relative_path || p.name },
        { id: "extension_type", labelKey: "custom.col.type", width: 18, minWidth: 105, sortable: true, render: (p) => `<span class="ma-badge">${this.h(`custom.type.${p.extension_type || "other"}`)}</span>` },
        { id: "registered_node_count", labelKey: "custom.col.nodeTypes", width: 16, minWidth: 82, sortable: true, render: (p) => String(Number(p.registered_node_count || 0)) },
        { id: "workflow_count", labelKey: "custom.col.workflows", width: 17, minWidth: 82, sortable: true, render: (p) => String(Number(p.workflow_count || 0)) },
        { id: "status", labelKey: "custom.col.registration", width: 27, minWidth: 120, sortable: false, render: (p) => `<span class="ma-badge${p.loaded ? " ma-badge-used" : ""}">${this.h(p.loaded ? "custom.status.registered" : "custom.status.notRegistered")}</span>` },
      ],
      customDisabled: [
        { id: "name", labelKey: "custom.col.package", width: 34, minWidth: 150, sortable: true, render: (p) => this.packageNameCell(p), title: (p) => p.relative_path || p.name },
        { id: "extension_type", labelKey: "custom.col.type", width: 15, minWidth: 105, sortable: true, render: (p) => `<span class="ma-badge">${this.h(`custom.type.${p.extension_type || "other"}`)}</span>` },
        { id: "registered_node_count", labelKey: "custom.col.nodeTypes", width: 13, minWidth: 82, sortable: true, render: (p) => String(Number(p.registered_node_count || 0)) },
        { id: "execution_count", labelKey: "custom.col.executions", width: 16, minWidth: 90, sortable: true, render: (p) => String(Number(p.execution_count || 0)) },
        { id: "last_executed", labelKey: "custom.col.lastUsed", width: 20, minWidth: 112, sortable: true, render: (p) => escapeHtml(this.date(p.last_executed)) },
        { id: "relative_path", labelKey: "custom.col.installPath", width: 17, minWidth: 125, sortable: true, render: (p) => escapeHtml(p.relative_path || "—"), title: (p) => p.relative_path || p.name },
      ],
      customWorkflow: [
        { id: "name", labelKey: "custom.col.workflow", width: 38, minWidth: 150, sortable: true, render: (w) => escapeHtml(w.name), title: (w) => w.name },
        { id: "package_names_text", labelKey: "custom.col.packages", width: 40, minWidth: 150, sortable: true, render: (w) => escapeHtml(w.package_names_text || "—"), title: (w) => w.package_names_text || "" },
        { id: "package_count", labelKey: "custom.col.packageCount", width: 11, minWidth: 75, sortable: true, render: (w) => String(Number(w.package_count || 0)) },
        { id: "node_type_count", labelKey: "custom.col.nodeTypes", width: 11, minWidth: 75, sortable: true, render: (w) => String(Number(w.node_type_count || 0)) },
      ],
    };
    return definitions[tableKey] || [];
  }

  readAllTableLayouts() {
    try {
      const raw = readSetting(SETTING.tableLayout, "");
      if (raw && typeof raw === "object") return raw;
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  readTableLayout(tableKey, columns) {
    const stored = Object.prototype.hasOwnProperty.call(this.tableLayoutCache, tableKey)
      ? this.tableLayoutCache[tableKey]
      : this.readAllTableLayouts()[tableKey] || {};
    return normalizeTableLayout(columns, stored);
  }

  saveTableLayout(tableKey, layout) {
    this.tableLayoutCache[tableKey] = layout;
    const allLayouts = { ...this.readAllTableLayouts() };
    allLayouts[tableKey] = layout;
    // Keep layout persistence within ComfyUI's settings store, alongside the
    // other dashboard preferences. This avoids a second storage mechanism.
    void writeSetting(SETTING.tableLayout, JSON.stringify(allLayouts));
  }

  renderDataTable(tableKey, rows) {
    const columns = this.tableColumnDefinitions(tableKey);
    const layout = this.readTableLayout(tableKey, columns);
    const byId = new Map(columns.map((column) => [column.id, column]));
    const ordered = layout.order.map((id) => byId.get(id)).filter(Boolean);
    const resizableIds = new Set(getResizableColumnIds(ordered.map((column) => column.id)));
    return `
      <div class="ma-table-scroll">
        <table class="ma-table" data-table="${tableKey}">
          <colgroup>
            ${ordered.map((column) => `<col data-ma-column="${column.id}" style="width:${layout.widths[column.id]}%">`).join("")}
          </colgroup>
          <thead><tr>
            ${ordered.map((column) => this.headerCell(column.labelKey, column.id, tableKey, column.sortable, resizableIds.has(column.id))).join("")}
          </tr></thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                ${ordered.map((column) => {
                  const title = column.title ? ` title="${escapeHtml(column.title(row))}"` : "";
                  return `<td${title}>${column.render(row)}</td>`;
                }).join("")}
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  renderUsedTab() {
    const stats = calculateInventoryStats(this.data.models || []);
    const filtered = this.sourceFilteredInventory();
    if (this.usageSourceFilter !== "all" && this.sourceUsageLoading && !this.sourceUsageData) {
      return `<div class="ma-empty-state"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> ${this.h("usage.filter.loading")}</div>`;
    }
    if (this.usageSourceFilter !== "all" && this.sourceUsageError) {
      return `<div class="ma-empty-state ma-source-filter-error">${this.h("usage.filter.error", { message: this.sourceUsageError })}</div>`;
    }
    const used = this.usageSourceFilter === "all" ? stats.used : (filtered?.used || []);
    const state = this.sortState.used;
    const sorted = this.sortRows(used, state.col, state.dir);
    const variant = this.usedThresholdEnabled ? "window" : "all";
    const days = this.usedThresholdDays;

    if (!sorted.length) {
      return this.usageSourceFilter === "all"
        ? `<div class="ma-empty-state">${this.h(`used.empty.${variant}`, { days })}</div>`
        : `<div class="ma-empty-state">${this.h("usage.noModels")}</div>`;
    }

    const summary = this.usageSourceFilter === "all"
      ? this.h(`used.summary.${variant}`, { used: bold(used.length), total: bold(stats.used.length + stats.unused.length), days })
      : this.h(`used.summary.source.${variant}`, {
          used: bold(used.length),
          total: bold(stats.used.length + stats.unused.length),
          days,
          source: this.t(`usage.source.${this.usageSourceFilter}`),
        });

    return `<div class="ma-summary">${summary}</div>${this.renderDataTable("used", sorted)}`;
  }

  renderUnusedTab() {
    const stats = calculateInventoryStats(this.data.models || []);
    const filtered = this.sourceFilteredInventory();
    if (this.usageSourceFilter !== "all" && this.sourceUsageLoading && !this.sourceUsageData) {
      return `<div class="ma-empty-state"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> ${this.h("usage.filter.loading")}</div>`;
    }
    if (this.usageSourceFilter !== "all" && this.sourceUsageError) {
      return `<div class="ma-empty-state ma-source-filter-error">${this.h("usage.filter.error", { message: this.sourceUsageError })}</div>`;
    }
    const unused = this.usageSourceFilter === "all" ? stats.unused : (filtered?.unused || []);
    const state = this.sortState.unused;
    const sorted = this.sortRows(unused, state.col, state.dir);
    const totalBytes = this.usageSourceFilter === "all"
      ? stats.unusedBytes
      : unused.reduce((sum, model) => sum + Math.max(0, Number(model.size_bytes) || 0), 0);
    const variant = this.usedThresholdEnabled ? "window" : "all";

    if (!sorted.length) {
      return `<div class="ma-empty-state">${this.h("unused.empty")}</div>`;
    }

    const summary = this.usageSourceFilter === "all"
      ? this.h(`unused.summary.${variant}`, { count: bold(unused.length), size: bold(this.size(totalBytes)), days: this.usedThresholdDays })
      : this.h(`unused.summary.source.${variant}`, {
          count: bold(unused.length),
          size: bold(this.size(totalBytes)),
          days: this.usedThresholdDays,
          source: this.t(`usage.source.${this.usageSourceFilter}`),
        });

    return `<div class="ma-summary">${summary}</div>${this.renderDataTable("unused", sorted)}`;
  }

  renderDisabledTab() {
    const stats = calculateInventoryStats(this.data.models || []);
    const disabled = stats.disabled;
    const state = this.sortState.disabled;
    const sorted = this.sortRows(disabled, state.col, state.dir);
    const disabledBytes = stats.disabledBytes;

    if (!sorted.length) {
      return `<div class="ma-empty-state">${this.h("disabled.empty")}</div>`;
    }

    return `
      <div class="ma-summary">${this.h("disabled.summary", { count: bold(sorted.length), suffix: code(".disabled"), size: bold(this.size(disabledBytes)) })}</div>
      ${this.renderDataTable("disabled", sorted)}
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
      ${modelsInWorkflow.length ? this.renderDataTable("workflow", modelsInWorkflow) : `<div class="ma-empty-state">${this.h("workflow.noModels", { name: this.selectedWorkflow })}</div>`}
    `;
  }

  headerCell(labelKey, col, tableKey, sortable = true, hasResizeHandle = true) {
    const state = sortable ? this.sortState[tableKey] : null;
    const arrow = state?.col === col ? (state.dir === 1 ? "▲" : "▼") : "";
    const sortAttr = sortable ? `data-col="${col}"` : "";
    return `
      <th data-ma-column="${col}" data-table-key="${tableKey}" ${sortAttr} draggable="true">
        <span class="ma-th-content">
          <span class="ma-col-drag" aria-hidden="true">⠿</span>
          <span class="ma-th-label">${this.h(labelKey)}</span>
          ${sortable ? `<span class="ma-sort-arrow">${arrow}</span>` : ""}
        </span>
        ${hasResizeHandle ? `<span class="ma-col-resizer" data-ma-resize="${col}" role="separator" aria-orientation="vertical" aria-label="Resize column"></span>` : ""}
      </th>
    `;
  }

  attachSortHandlers(body) {
    body.querySelectorAll("table.ma-table[data-table]").forEach((table) => {
      const tableKey = table.dataset.table;
      const columns = this.tableColumnDefinitions(tableKey);

      table.querySelectorAll("th[data-ma-column]").forEach((th) => {
        const columnId = th.dataset.maColumn;

        if (th.hasAttribute("data-col")) {
          th.addEventListener("click", (event) => {
            if (event.target?.closest?.(".ma-col-resizer") || th.dataset.maSuppressSort === "true") return;
            const col = th.dataset.col;
            const state = this.sortState[tableKey];
            if (!state) return;
            if (state.col === col) state.dir *= -1;
            else {
              state.col = col;
              state.dir = 1;
            }
            this.render();
          });
        }

        th.addEventListener("dragstart", (event) => {
          if (event.target?.closest?.(".ma-col-resizer")) {
            event.preventDefault();
            return;
          }
          th.dataset.maSuppressSort = "true";
          th.classList.add("ma-column-dragging");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", columnId);
          }
        });

        th.addEventListener("dragover", (event) => {
          if (th.classList.contains("ma-column-dragging")) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          th.classList.add("ma-column-drop-target");
        });

        th.addEventListener("dragleave", () => th.classList.remove("ma-column-drop-target"));

        th.addEventListener("drop", (event) => {
          event.preventDefault();
          th.classList.remove("ma-column-drop-target");
          const sourceId = event.dataTransfer?.getData("text/plain");
          if (!sourceId || sourceId === columnId) return;
          const layout = this.readTableLayout(tableKey, columns);
          const targetBounds = th.getBoundingClientRect();
          const dropPosition = event.clientX >= targetBounds.left + targetBounds.width / 2 ? "after" : "before";
          const next = reorderTableColumn(layout, sourceId, columnId, dropPosition);
          this.saveTableLayout(tableKey, next);
          this.render();
        });

        th.addEventListener("dragend", () => {
          th.classList.remove("ma-column-dragging");
          table.querySelectorAll(".ma-column-drop-target").forEach((node) => node.classList.remove("ma-column-drop-target"));
          window.setTimeout(() => { th.dataset.maSuppressSort = "false"; }, 0);
        });

        const resizer = th.querySelector(".ma-col-resizer");
        if (!resizer) return;
        resizer.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const layout = this.readTableLayout(tableKey, columns);
          const width = table.getBoundingClientRect().width;
          if (!width) return;
          const startX = event.clientX;
          let latest = layout;
          table.classList.add("ma-table-resizing");
          document.documentElement.classList.add("ma-column-resizing");

          const onMove = (moveEvent) => {
            moveEvent.preventDefault();
            const rawDelta = moveEvent.clientX - startX;
            latest = resizeAdjacentColumns(layout, columns, columnId, rawDelta, width);
            table.querySelectorAll("col[data-ma-column]").forEach((col) => {
              const nextWidth = latest.widths[col.dataset.maColumn];
              if (Number.isFinite(nextWidth)) col.style.width = `${nextWidth}%`;
            });
          };

          const finish = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", finish);
            table.classList.remove("ma-table-resizing");
            document.documentElement.classList.remove("ma-column-resizing");
            this.saveTableLayout(tableKey, latest);
          };

          window.addEventListener("pointermove", onMove, { passive: false });
          window.addEventListener("pointerup", finish, { once: true });
          window.addEventListener("pointercancel", finish, { once: true });
        });
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

// Definitions handed to ComfyUI at registration. They are kept so their
// texts can be updated in place when the language changes (the settings
// dialog reads them again each time it is opened).
let registeredSettings = [];
const actionBarButtons = [];

function updateMenuButtonLabel() {
  if (!menuButton) return;
  const tr = createTranslator(resolveLanguage());
  let label = menuButton.querySelector(".ma-menu-btn-label");
  if (!label) {
    menuButton.innerHTML = '<span class="ma-menu-btn-icon"><i class="pi pi-chart-bar" aria-hidden="true"></i></span><span class="ma-menu-btn-label"></span>';
    label = menuButton.querySelector(".ma-menu-btn-label");
  }
  label.textContent = tr.t("app.menuButton");
  menuButton.title = tr.t("action.open");
  menuButton.setAttribute("aria-label", tr.t("action.open"));
}

function updateActionBarButtons() {
  const tr = createTranslator(resolveLanguage());
  for (const button of actionBarButtons) {
    button.label = tr.t("app.menuButton");
    button.tooltip = tr.t("action.open");
    // Keep the custom class in place when labels are refreshed after a
    // language change; ComfyUI applies this class to the actual button.
    button.class = "ma-actionbar-button";
  }
}

// Copies freshly translated texts onto the definitions ComfyUI already
// holds. Ids, defaults and callbacks stay untouched.
function relocalizeSettings() {
  const fresh = buildSettingsDefinitions();
  for (const definition of fresh) {
    const target = registeredSettings.find((item) => item.id === definition.id);
    if (!target) continue;
    target.name = definition.name;
    target.tooltip = definition.tooltip;
    target.category = definition.category;
    if (definition.options) target.options = definition.options;
  }
}

function onAnySettingChanged() {
  // ComfyUI also fires onChange once per setting while registering them,
  // before the dashboard exists - hence the guards.
  updateMenuButtonLabel();
  updateActionBarButtons();
  relocalizeSettings();
  dashboard?.onSettingsChanged();
}

function onRecencySettingChanged() {
  dashboard?.onRecencyChanged();
}

// Setting labels are resolved from the language that is active when they
// are built. At registration that is the language at page load; after a
// language change relocalizeSettings() refreshes them in place, so the
// ComfyUI settings dialog shows the new language the next time it opens.
function buildSettingsDefinitions() {
  const { t } = createTranslator(resolveLanguage());
  const section = "Analytics";
  const general = t("settings.group.general");
  const models = t("settings.group.models");
  const customNodes = t("settings.group.customNodes");
  const recency = t("settings.group.recency");

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
  const boolean = (id, group, nameKey, tipKey, defaultValue) => ({
    id,
    name: t(nameKey),
    category: [section, group, t(nameKey)],
    type: "boolean",
    tooltip: t(tipKey),
    defaultValue,
    onChange: onAnySettingChanged,
  });

  return [
    combo(
      SETTING.language, general, "settings.language.name", "settings.language.tooltip",
      [
        { text: t("settings.language.auto"), value: LANGUAGE_AUTO },
        ...LANGUAGES.map((language) => ({ text: language.label, value: language.code })),
      ],
      LANGUAGE_AUTO,
    ),
    combo(
      SETTING.defaultSection, general, "settings.defaultSection.name", "settings.defaultSection.tooltip",
      [
        { text: t("section.models"), value: "models" },
        { text: t("section.customNodes"), value: "customNodes" },
      ],
      "models",
    ),
    combo(
      SETTING.density, general, "settings.density.name", "settings.density.tooltip",
      [
        { text: t("settings.density.normal"), value: "normal" },
        { text: t("settings.density.compact"), value: "compact" },
      ],
      "normal",
    ),
    combo(
      SETTING.dateFormat, general, "settings.dateFormat.name", "settings.dateFormat.tooltip",
      [
        { text: t("settings.dateFormat.system"), value: "system" },
        { text: t("settings.dateFormat.iso"), value: "iso" },
      ],
      "system",
    ),
    boolean(SETTING.recencyEnabled, recency, "settings.recency.enabled.name", "settings.recency.enabled.tooltip", true),
    {
      id: SETTING.recencyDays,
      name: t("settings.recency.days.name"),
      category: [section, recency, t("settings.recency.days.name")],
      type: "number",
      attrs: { min: 1, step: 1 },
      tooltip: t("settings.recency.days.tooltip"),
      defaultValue: DEFAULT_RECENCY_DAYS,
      onChange: onRecencySettingChanged,
    },
    combo(
      SETTING.sizeUnit, models, "settings.sizeUnit.name", "settings.sizeUnit.tooltip",
      [
        { text: t("settings.sizeUnit.binary"), value: "binary" },
        { text: t("settings.sizeUnit.decimal"), value: "decimal" },
      ],
      "binary",
    ),
    combo(
      SETTING.defaultTab, models, "settings.defaultTab.name", "settings.defaultTab.tooltip",
      DATA_TABS.map((tab) => ({ text: t(`tab.${tab}`), value: tab })),
      "used",
    ),
    boolean(SETTING.customNodeTrackingEnabled, customNodes, "settings.customNodes.tracking.name", "settings.customNodes.tracking.tooltip", true),
    boolean(SETTING.customNodeScanWorkflows, customNodes, "settings.customNodes.scan.name", "settings.customNodes.scan.tooltip", true),
    {
      id: SETTING.starBannerDismissed,
      name: "Analytics star banner dismissed",
      type: "hidden",
      defaultValue: false,
      onChange: onAnySettingChanged,
    },
    {
      id: SETTING.appearance,
      name: "Analytics appearance preference",
      type: "hidden",
      defaultValue: "follow",
      onChange: onAnySettingChanged,
    },
    {
      id: SETTING.customAppearance,
      name: "Analytics custom appearance values",
      type: "hidden",
      defaultValue: "",
      onChange: onAnySettingChanged,
    },
    {
      id: SETTING.tableLayout,
      name: "Analytics table layouts",
      type: "hidden",
      defaultValue: "",
    },
    {
      id: SETTING.usageSource,
      name: "Model Analytics usage source filter",
      type: "hidden",
      defaultValue: "all",
      onChange: onAnySettingChanged,
    },
  ];
}

// One-time carry-over of preferences that older builds kept in the
// browser's localStorage into the ComfyUI settings. A legacy key is only
// removed after its value was saved successfully, so nothing gets lost.
async function migrateLegacyLocalPreferences() {
  try {
    if (localStorage.getItem(LEGACY_STAR_BANNER_DISMISSED_KEY)) {
      const migrated = await writeSetting(SETTING.starBannerDismissed, true);
      if (migrated) localStorage.removeItem(LEGACY_STAR_BANNER_DISMISSED_KEY);
    }

    const storedEnabled = localStorage.getItem(LEGACY_USED_THRESHOLD_ENABLED_KEY);
    if (storedEnabled !== null) {
      const migrated = await writeSetting(SETTING.recencyEnabled, storedEnabled === "1");
      if (migrated) localStorage.removeItem(LEGACY_USED_THRESHOLD_ENABLED_KEY);
    }

    const storedDaysRaw = localStorage.getItem(LEGACY_USED_THRESHOLD_DAYS_KEY);
    if (storedDaysRaw !== null) {
      const storedDays = parseFloat(storedDaysRaw);
      const valid = Number.isFinite(storedDays) && storedDays > 0;
      const migrated = valid ? await writeSetting(SETTING.recencyDays, storedDays) : true;
      if (migrated) localStorage.removeItem(LEGACY_USED_THRESHOLD_DAYS_KEY);
    }
  } catch {
    // localStorage unavailable - nothing to migrate.
  }
}

// Entry point for ComfyUI's legacy menu (Settings -> Comfy -> "Use new
// menu" = Disabled) and for older frontends without the modern action bar.
// Modern-menu mode uses the native action-bar button instead.
function addLegacyMenuButton() {
  // ComfyUI can re-run extension setup during frontend reloads. Remove a
  // previous instance first so the same extension never leaves duplicate
  // visible buttons behind.
  document.querySelectorAll("[data-ma-menu-button='true']").forEach((button) => button.remove());
  menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.dataset.maMenuButton = "true";
  menuButton.className = "comfy-menu-btn ma-btn ma-menu-btn";
  updateMenuButtonLabel();
  menuButton.addEventListener("click", () => {
    updateMenuButtonLabel();
    dashboard.open();
  });

  if (app.menu?.settingsGroup?.element) {
    app.menu.settingsGroup.element.before(menuButton);
    return;
  }
  const menu = document.querySelector(".comfy-menu");
  if (menu) {
    menu.appendChild(menuButton);
    return;
  }
  // Last resort - only when no new-style menu is in use either: a
  // floating button in the corner (styled in style.css).
  if (legacyMenuInUse()) {
    menuButton.className = "comfy-menu-btn ma-btn ma-floating-btn ma-menu-btn";
    document.body.appendChild(menuButton);
  } else {
    menuButton = null;
  }
}

function openDashboard() {
  dashboard?.open();
}

registeredSettings = buildSettingsDefinitions();
// Exactly one visible entry point: the styled menu button in legacy-menu
// mode, or the native action-bar button in the modern menu. Do not also add
// an Extensions menu command, which would create a second Model Analytics
// entry beside the button.
if (!legacyMenuInUse()) {
  const { t } = createTranslator(resolveLanguage());
  actionBarButtons.push({
    icon: "pi pi-chart-bar",
    label: t("app.menuButton"),
    tooltip: t("action.open"),
    class: "ma-actionbar-button",
    onClick: openDashboard,
  });
}

app.registerExtension({
  name: "Comfy.ModelAnalytics",
  settings: registeredSettings,
  commands: [
    {
      id: "ModelAnalytics.Open",
      label: "Analytics",
      icon: "pi pi-chart-bar",
      function: openDashboard,
    },
  ],
  // The legacy menu needs its own styled button. Modern ComfyUI uses the
  // single native action-bar entry registered above.
  actionBarButtons,
  async setup() {
    injectCss();
    await migrateLegacyLocalPreferences();
    dashboard = new ModelAnalyticsDashboard();
    if (legacyMenuInUse()) addLegacyMenuButton();
    const api = app.api;
    if (api?.addEventListener && !api.__modelAnalyticsRefreshBound) {
      const refreshInventory = (eventName) => {
        const section = dashboard?.activeSection;
        if (section === "customNodes" && eventName !== "execution_success") return;
        if (section === "models" && eventName !== "execution_start") return;
        dashboard?.scheduleExecutionRefresh();
      };
      for (const eventName of ["execution_start", "execution_success", "execution_error", "execution_interrupted"]) {
        api.addEventListener(eventName, () => refreshInventory(eventName));
      }
      api.__modelAnalyticsRefreshBound = true;
    }
  },
});
