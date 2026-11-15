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

// Bump this whenever main.js/style.css change, so the injected <link> tag
// gets a fresh URL and browsers can't serve a stale cached copy of the CSS.
// (main.js itself is loaded by ComfyUI's own extension loader - if you
// don't see JS changes after an update, hard-refresh the browser tab,
// e.g. Ctrl+Shift+R / Cmd+Shift+R, or disable cache in devtools.)
const EXT_VERSION = "142";

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
  recencyEnabled: "ModelAnalytics.RecencyEnabled",
  recencyDays: "ModelAnalytics.RecencyDays",
};
const COMFY_LOCALE_SETTING = "Comfy.Locale";
// "Disabled" means ComfyUI shows its legacy floating menu instead of the
// new top menu / action bar.
const COMFY_MENU_SETTING = "Comfy.UseNewMenu";

const LANGUAGE_AUTO = "auto";
const DATA_TABS = ["used", "unused", "disabled", "workflow"];
const TABS = [...DATA_TABS, "settings"];
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
    this.activeTab = "used";
    this.sortState = { used: { col: "last_activity", dir: -1 }, unused: { col: "size_bytes", dir: -1 }, disabled: { col: "size_bytes", dir: -1 } };
    this.selectedWorkflow = null;
    this.overlay = null;
    this.usedThresholdDays = DEFAULT_RECENCY_DAYS;
    this.custom = { colors: {} };
    this.paletteSnapshot = null;
    this.openAppearancePanel = null;
    this.executionRefreshTimer = null;
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
    this.activeTab = this.settings.defaultTab;
    this.buildModal();
    await this.refresh();
  }

  close() {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  // Called by the ComfyUI settings system when one of our settings
  // changes while the dashboard is open.
  onSettingsChanged() {
    const recency = { enabled: this.usedThresholdEnabled, days: this.usedThresholdDays };
    const previous = this.settings;
    const previousLanguage = this.tr.code;
    this.loadSettings();
    this.resolvePaletteSnapshot();
    this.usedThresholdEnabled = recency.enabled;
    this.usedThresholdDays = recency.days;
    if (!this.overlay) return;

    if (this.tr.code !== previousLanguage || this.settings.starBanner !== previous.starBanner) {
      this.close();
      this.buildModal();
      if (this.data) this.render();
      return;
    }

    this.applyLiveSettings();
    const changed = ["appearancePreference", "paletteId", "sizeUnit", "dateFormat", "density"].some((key) => previous[key] !== this.settings[key]);
    if (changed) this.render();
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
      if (this.overlay) this.refresh({ quiet: this.activeTab === "settings" });
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
    if (this.activeTab !== "settings") {
      const body = this.overlay.querySelector(".ma-body");
      body.innerHTML = `<div class="ma-summary">${this.h("common.loading")}</div>`;
    }
    await this.refresh();
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
    overlay.innerHTML = `
      <div class="ma-modal${densityClass}${showBanner ? " ma-modal--banner" : ""}" role="dialog" aria-modal="true" aria-label="${this.h("app.title")}">
        <div class="ma-header">
          <h2 class="ma-title"><i class="pi pi-chart-bar" aria-hidden="true"></i>${this.h("app.title")}</h2>
          <div class="ma-header-right">
            <label class="ma-stale-control" title="${this.h("header.recency.tooltip")}">
              <input type="checkbox" class="ma-stale-toggle" ${this.usedThresholdEnabled ? "checked" : ""} />
              ${this.h("header.recency.before")}
              <input type="number" class="ma-stale-input" min="1" step="1" value="${escapeHtml(this.usedThresholdDays)}" ${this.usedThresholdEnabled ? "" : "disabled"} />
              ${this.h("header.recency.after")}
            </label>
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
          ${TABS.map((tab) => `<button type="button" role="tab" class="ma-tab-btn" data-tab="${tab}">${this.h(`tab.${tab}`)}<span class="ma-tab-count" hidden></span></button>`).join("")}
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
        this.activeTab = btn.dataset.tab;
        this.render();
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
    } catch (e) {
      const body = this.overlay?.querySelector(".ma-body");
      if (body && !quiet) {
        body.innerHTML = `<div class="ma-empty-state">${this.h("common.loadError", { message: e.message })}</div>`;
      }
      return;
    }
    this.render({ preserveSettings: quiet && this.activeTab === "settings" });
  }

  tabCounts() {
    if (!this.data) return {};
    const stats = calculateInventoryStats(this.data.models || []);
    return {
      used: stats.used.length,
      unused: stats.unused.length,
      disabled: stats.disabled.length,
      workflow: (this.data.workflow_names || []).length,
    };
  }

  render({ preserveSettings = false } = {}) {
    if (!this.overlay) return;
    const counts = this.tabCounts();
    this.overlay.querySelectorAll(".ma-tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === this.activeTab;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      const badge = btn.querySelector(".ma-tab-count");
      const count = counts[btn.dataset.tab];
      if (badge) {
        badge.hidden = count === undefined;
        if (count !== undefined) badge.textContent = String(count);
      }
    });

    const body = this.overlay.querySelector(".ma-body");
    if (preserveSettings && this.activeTab === "settings") return;
    if (this.activeTab === "settings") {
      body.classList.add("ma-body-settings");
      body.innerHTML = this.renderSettingsTab();
      return;
    }
    body.classList.remove("ma-body-settings");
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

  // Builds native select options for the custom appearance editor. Keep this
  // helper on the dashboard class so Settings can render independently of the
  // currently selected data tab.
  optionsHtml(options, value) {
    return options.map((option) =>
      `<option value="${escapeHtml(option.value)}" ${option.value === value ? "selected" : ""}>${escapeHtml(option.text)}</option>`,
    ).join("");
  }

  settingOptions(id) {
    const tr = this.tr;
    const choices = {
      [SETTING.language]: [
        { value: LANGUAGE_AUTO, text: tr.t("settings.language.auto") },
        ...LANGUAGES.map((language) => ({ value: language.code, text: language.label })),
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
        </section>
        <section class="ma-settings-section">
          <h3>${this.h("settings.group.appearance")}</h3>
          ${this.renderAppearanceSettings()}
          ${this.renderSettingSelect(SETTING.density, "settings.density.name", "settings.density.tooltip", this.settings.density)}
        </section>
        <section class="ma-settings-section">
          <h3>${this.h("settings.group.recency")}</h3>
          ${this.renderSettingToggle(SETTING.recencyEnabled, "settings.recency.enabled.name", "settings.recency.enabled.tooltip", this.usedThresholdEnabled)}
          ${this.renderSettingNumber(SETTING.recencyDays, "settings.recency.days.name", "settings.recency.days.tooltip", this.usedThresholdDays, !this.usedThresholdEnabled)}
        </section>
        <section class="ma-settings-section">
          <h3>${this.h("settings.group.display")}</h3>
          ${this.renderSettingSelect(SETTING.sizeUnit, "settings.sizeUnit.name", "settings.sizeUnit.tooltip", this.settings.sizeUnit)}
          ${this.renderSettingSelect(SETTING.dateFormat, "settings.dateFormat.name", "settings.dateFormat.tooltip", this.settings.dateFormat)}
          ${this.renderSettingSelect(SETTING.defaultTab, "settings.defaultTab.name", "settings.defaultTab.tooltip", this.settings.defaultTab)}
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
    const stats = calculateInventoryStats(this.data.models || []);
    const used = stats.used;
    const state = this.sortState.used;
    const sorted = this.sortRows(used, state.col, state.dir);
    const variant = this.usedThresholdEnabled ? "window" : "all";
    const days = this.usedThresholdDays;

    if (!sorted.length) {
      return `<div class="ma-empty-state">${this.h(`used.empty.${variant}`, { days })}</div>`;
    }

    return `
      <div class="ma-summary">${this.h(`used.summary.${variant}`, { used: bold(used.length), total: bold(stats.used.length + stats.unused.length), days })}</div>
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
    const stats = calculateInventoryStats(this.data.models || []);
    const unused = stats.unused;
    const state = this.sortState.unused;
    const sorted = this.sortRows(unused, state.col, state.dir);
    const totalBytes = stats.unusedBytes;
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
    // Keep the visual button class when labels are refreshed after a language change.
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
  const section = "Model Analytics";
  const general = t("settings.group.general");
  const display = t("settings.group.display");
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

  return [
    combo(
      SETTING.language, general, "settings.language.name", "settings.language.tooltip",
      [
        { text: t("settings.language.auto"), value: LANGUAGE_AUTO },
        ...LANGUAGES.map((l) => ({ text: l.label, value: l.code })),
      ],
      LANGUAGE_AUTO,
    ),
    {
      id: SETTING.recencyEnabled,
      name: t("settings.recency.enabled.name"),
      category: [section, recency, t("settings.recency.enabled.name")],
      type: "boolean",
      tooltip: t("settings.recency.enabled.tooltip"),
      defaultValue: true,
      onChange: onRecencySettingChanged,
    },
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
      id: SETTING.starBannerDismissed,
      name: "Model Analytics star banner dismissed",
      type: "hidden",
      defaultValue: false,
      onChange: onAnySettingChanged,
    },
    {
      id: SETTING.appearance,
      name: "Model Analytics appearance preference",
      type: "hidden",
      defaultValue: "follow",
      onChange: onAnySettingChanged,
    },
    {
      id: SETTING.customAppearance,
      name: "Model Analytics custom appearance values",
      type: "hidden",
      defaultValue: "",
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
      label: "Model Analytics",
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
      const refreshInventory = () => dashboard?.scheduleExecutionRefresh();
      for (const eventName of ["execution_start", "execution_success", "execution_error", "execution_interrupted"]) {
        api.addEventListener(eventName, refreshInventory);
      }
      api.__modelAnalyticsRefreshBound = true;
    }
  },
});
