// Appearance layer of the dashboard (no ComfyUI imports, so it can be tested
// on its own).
//
// Appearance modes:
//   follow  - inherit the active ComfyUI CSS variables.
//   palette - use a snapshot of another ComfyUI palette, scoped to this
//             dashboard only.
//   custom  - apply the user's optional token overrides.
//
// Palette snapshots are read from ComfyUI's in-memory palette registry and
// copied onto the dashboard element. No global palette switch is performed.

export const APPEARANCE_MODES = ["follow", "palette", "custom"];

// Semantic CSS variables currently used by the ComfyUI design system, plus
// legacy aliases still used by older frontend releases. Keep this list
// deliberately small: only variables that affect this dashboard are copied.
export const PALETTE_CSS_PROPERTIES = [
  "--background",
  "--foreground",
  "--card",
  "--primary",
  "--secondary",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--destructive",
  "--border",
  "--ring",
  "--input",
  "--popover",
  "--node",
  "--warning",
  "--color-success",
  "--shadow-color",
  "--node-foreground",
  "--node-header",
  "--node-border",
  "--fg-color",
  "--bg-color",
  "--comfy-menu-bg",
  "--comfy-menu-secondary-bg",
  "--comfy-input-bg",
  "--input-text",
  "--descrip-text",
  "--drag-text",
  "--error-text",
  "--border-color",
  "--content-bg",
  "--content-fg",
  "--content-hover-bg",
  "--content-hover-fg",
  "--tr-even-bg-color",
  "--tr-odd-bg-color",
];

// Built-in palette ids from ComfyUI's core color palette registry. Custom
// palettes are appended from Comfy.CustomColorPalettes at runtime.
export const BUILTIN_COMFY_PALETTES = [
  { id: "dark", name: "Dark" },
  { id: "light", name: "Light" },
  { id: "solarized", name: "Solarized" },
  { id: "arc", name: "Arc" },
  { id: "nord", name: "Nord" },
  { id: "github", name: "GitHub" },
  { id: "spooky", name: "Spooky" },
  { id: "skeleton", name: "Skeleton" },
  { id: "witch", name: "Witch" },
  { id: "zombie", name: "Zombie" },
  { id: "fennec", name: "Fennec Girl" },
];
export const SCHEMES = ["inherit", "dark", "light"];

// `id` doubles as the property suffix: --ma-custom-<id>.
export const COLOR_TOKENS = [
  { id: "bg", labelKey: "settings.custom.bg" },
  { id: "surface", labelKey: "settings.custom.surface" },
  { id: "fg", labelKey: "settings.custom.fg" },
  { id: "muted", labelKey: "settings.custom.muted" },
  { id: "accent", labelKey: "settings.custom.accent" },
  { id: "accent-fg", labelKey: "settings.custom.accentFg" },
  { id: "border", labelKey: "settings.custom.border" },
  { id: "input-bg", labelKey: "settings.custom.inputBg" },
  { id: "input-fg", labelKey: "settings.custom.inputFg" },
  { id: "hover", labelKey: "settings.custom.hover" },
  { id: "active", labelKey: "settings.custom.active" },
  { id: "success", labelKey: "settings.custom.success" },
  { id: "danger", labelKey: "settings.custom.danger" },
];

export const RADIUS_RANGE = { min: 0, max: 12, fallback: 6 };
export const FONT_SIZE_RANGE = { min: 11, max: 16, fallback: 13 };

const TOKEN_IDS = new Set(COLOR_TOKENS.map((token) => token.id));
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function clampNumber(value, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, Math.round(number)));
}

// Accepts the stored JSON string and returns a clean object. Anything that
// is malformed or out of range is dropped instead of being applied.
export function parseCustomAppearance(raw) {
  const result = { colors: {} };
  let data;
  try {
    data = typeof raw === "string" && raw.trim() ? JSON.parse(raw) : raw;
  } catch {
    return result;
  }
  if (!data || typeof data !== "object") return result;

  const colors = data.colors && typeof data.colors === "object" ? data.colors : {};
  for (const [id, value] of Object.entries(colors)) {
    if (TOKEN_IDS.has(id) && typeof value === "string" && HEX_COLOR.test(value)) {
      result.colors[id] = value.toLowerCase();
    }
  }
  const radius = clampNumber(data.radius, RADIUS_RANGE);
  if (radius !== undefined && data.radius !== null && data.radius !== "") result.radius = radius;
  const fontSize = clampNumber(data.fontSize, FONT_SIZE_RANGE);
  if (fontSize !== undefined && data.fontSize !== null && data.fontSize !== "") result.fontSize = fontSize;
  if (SCHEMES.includes(data.scheme) && data.scheme !== "inherit") result.scheme = data.scheme;
  return result;
}

// Stable output: an empty customisation is stored as an empty string.
export function serializeCustomAppearance(custom) {
  const clean = parseCustomAppearance(custom);
  const hasColors = Object.keys(clean.colors).length > 0;
  if (!hasColors && clean.radius === undefined && clean.fontSize === undefined && !clean.scheme) {
    return "";
  }
  const out = {};
  if (hasColors) {
    out.colors = Object.fromEntries(
      COLOR_TOKENS.filter((token) => clean.colors[token.id]).map((token) => [token.id, clean.colors[token.id]]),
    );
  }
  if (clean.radius !== undefined) out.radius = clean.radius;
  if (clean.fontSize !== undefined) out.fontSize = clean.fontSize;
  if (clean.scheme) out.scheme = clean.scheme;
  return JSON.stringify(out);
}

// Reads the CSS variables produced by ComfyUI for the currently active palette.
export function readComfyPaletteCss(root = document.documentElement) {
  const computed = getComputedStyle(root);
  const variables = {};
  for (const property of PALETTE_CSS_PROPERTIES) {
    const value = computed.getPropertyValue(property).trim();
    if (value) variables[property] = value;
  }
  return { variables, colorScheme: computed.colorScheme || "" };
}

function restoreAttribute(element, name, value) {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

// Convert a ComfyUI palette definition into the same CSS custom properties
// ComfyUI applies to :root. This reads the palette registry without switching
// the global theme or changing LiteGraph/canvas colours.
function deriveLegacyTheme(colors = {}) {
  const comfy = colors.comfy_base || {};
  const litegraph = colors.litegraph_base || {};
  const surface = comfy["interface-panel-surface"] ?? comfy["comfy-menu-bg"];
  const contrast = comfy["contrast-mix-color"] ?? "#fff";
  const mixWithContrast = (percent) => surface
    ? `color-mix(in srgb, ${surface} ${percent}%, ${contrast})`
    : undefined;
  return {
    background: surface,
    foreground: comfy["fg-color"],
    "muted-foreground": comfy["descrip-text"],
    border: comfy["interface-stroke"] ?? mixWithContrast(75.5),
    accent: comfy["interface-panel-hover-surface"] ?? comfy["interface-button-hover-surface"] ?? mixWithContrast(92.5),
    muted: comfy["interface-panel-selected-surface"] ?? mixWithContrast(87.5),
    card: comfy["comfy-menu-secondary-bg"],
    secondary: litegraph.NODE_DEFAULT_COLOR,
    input: litegraph.WIDGET_BGCOLOR,
    node: litegraph.NODE_DEFAULT_BGCOLOR,
    "node-foreground": litegraph.NODE_TEXT_COLOR,
    "node-header": litegraph.NODE_DEFAULT_COLOR,
    "node-border": litegraph.WIDGET_OUTLINE_COLOR,
  };
}

function getCompletedPalette(paletteStore, paletteId) {
  const palette = paletteStore?.palettesLookup?.[paletteId];
  if (!palette) return null;
  try {
    return typeof paletteStore.completePalette === "function"
      ? paletteStore.completePalette(palette)
      : palette;
  } catch {
    return null;
  }
}

function snapshotFromPalette(palette, paletteStore) {
  if (!palette || typeof palette !== "object") return null;
  const colors = palette.colors || {};
  const baseId = palette.light_theme ? "light" : "dark";
  const basePalette = paletteStore ? getCompletedPalette(paletteStore, baseId) : null;
  const isCorePalette = palette.id === "dark" || palette.id === "light";
  const derivedLegacy = isCorePalette ? {} : deriveLegacyTheme(colors);
  const theme = {
    ...(basePalette?.colors?.theme || {}),
    ...derivedLegacy,
    ...(colors.theme || {}),
  };
  const variables = {};

  for (const [key, value] of Object.entries(theme)) {
    const property = `--${key}`;
    if (PALETTE_CSS_PROPERTIES.includes(property) && typeof value === "string" && value.trim()) {
      variables[property] = value.trim();
    }
  }

  // Keep legacy variables too: Model Analytics and some ComfyUI components
  // still consume these aliases on older frontend releases.
  for (const [key, value] of Object.entries(colors.comfy_base || {})) {
    const property = `--${key}`;
    if (PALETTE_CSS_PROPERTIES.includes(property) && typeof value === "string" && value.trim()) {
      variables[property] = value.trim();
    }
  }

  if (!Object.keys(variables).length) return null;
  return { variables, colorScheme: palette.light_theme ? "light" : "dark" };
}

// Read a palette directly from ComfyUI's in-memory palette registry. No
// palette is temporarily activated: the user's global theme and workflow
// canvas are never touched. `fallbackPalettes` supports custom palette JSON
// from Comfy.CustomColorPalettes on frontends where the Vue store isn't
// reachable to extensions.
export function readComfyPaletteSnapshot(paletteStore, paletteId, fallbackActiveId = "", fallbackPalettes = {}) {
  if (!paletteId) return null;
  if (paletteStore?.palettesLookup) {
    const palette = getCompletedPalette(paletteStore, paletteId);
    if (palette) return snapshotFromPalette(palette, paletteStore);
  }
  const fallbackPalette = fallbackPalettes && typeof fallbackPalettes === "object"
    ? fallbackPalettes[paletteId]
    : null;
  if (fallbackPalette) return snapshotFromPalette(fallbackPalette, null);
  if (paletteId === fallbackActiveId) return readComfyPaletteCss(document.documentElement);
  return null;
}

// Writes a palette snapshot (palette mode), custom overrides (custom mode),
// or clears both local layers (follow mode). Only `element` is modified.
export function applyAppearance(element, mode, custom, paletteSnapshot = null) {
  const style = element.style;
  const customNames = [
    ...COLOR_TOKENS.map((token) => `--ma-custom-${token.id}`),
    "--ma-custom-radius",
    "--ma-custom-font-size",
  ];
  for (const name of customNames) style.removeProperty(name);
  for (const name of PALETTE_CSS_PROPERTIES) style.removeProperty(name);
  style.colorScheme = "";
  element.dataset.maAppearance = mode === "custom" || mode === "palette" ? mode : "follow";

  if (mode === "palette" && paletteSnapshot?.variables) {
    for (const [name, value] of Object.entries(paletteSnapshot.variables)) {
      if (PALETTE_CSS_PROPERTIES.includes(name)) style.setProperty(name, value);
    }
    style.colorScheme = paletteSnapshot.colorScheme || "";
    return;
  }

  if (mode !== "custom") return;
  const clean = parseCustomAppearance(custom);
  for (const [id, value] of Object.entries(clean.colors)) {
    style.setProperty(`--ma-custom-${id}`, value);
  }
  if (clean.radius !== undefined) style.setProperty("--ma-custom-radius", `${clean.radius}px`);
  if (clean.fontSize !== undefined) style.setProperty("--ma-custom-font-size", `${clean.fontSize}px`);
  if (clean.scheme) style.colorScheme = clean.scheme;
}

// Resolves any CSS colour (including color-mix() / var()) to #rrggbb by
// painting one pixel. Used to pre-fill the colour pickers with the value
// that is currently in effect. Returns null if it cannot be resolved.
export function cssColorToHex(cssColor) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000000";
    ctx.fillStyle = cssColor;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const hex = (n) => n.toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  } catch {
    return null;
  }
}

// The colour a token currently resolves to inside `scope` (the dashboard
// element, where the --ma-* variables are defined).
export function effectiveTokenHex(scope, tokenId) {
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;width:0;height:0;visibility:hidden;background-color:var(--ma-${tokenId});`;
  scope.appendChild(probe);
  const computed = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return cssColorToHex(computed) || "#000000";
}
