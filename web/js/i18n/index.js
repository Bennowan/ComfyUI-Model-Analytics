// Small, dependency-free translation layer for the dashboard.
//
// Adding a language:
//   1. Copy locales/en.js to locales/<code>.js and translate the values.
//   2. Import it below and add one entry to LANGUAGES.
// Missing keys fall back to English, so a partial translation never breaks
// the UI (the check script in the repo history flags incomplete ones).

import en from "./locales/en.js";
import de from "./locales/de.js";
import zh from "./locales/zh.js";
import zhTW from "./locales/zh-TW.js";
import ja from "./locales/ja.js";
import ko from "./locales/ko.js";

export const FALLBACK_LANGUAGE = "en";

// `label` is always the language's own name, so it stays readable no
// matter which language is currently active.
export const LANGUAGES = [
  { code: "en", label: "English", messages: en },
  { code: "de", label: "Deutsch", messages: de },
  { code: "zh", label: "简体中文", messages: zh },
  { code: "zh-TW", label: "繁體中文", messages: zhTW },
  { code: "ja", label: "日本語", messages: ja },
  { code: "ko", label: "한국어", messages: ko },
];

export function isSupportedLanguage(code) {
  return LANGUAGES.some((l) => l.code === code);
}

// File names, workflow names and error messages end up in innerHTML, so
// everything that is not a literal from this extension must be escaped.
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Parameter wrappers for tHtml(): `bold(5)` renders <b>5</b>, `code(".x")`
// renders <code>.x</code>. In plain-text mode they collapse to the text.
export function bold(value) {
  return { text: String(value), html: `<b>${escapeHtml(value)}</b>` };
}
export function code(value) {
  return { text: String(value), html: `<code>${escapeHtml(value)}</code>` };
}

// Maps a ComfyUI locale id (Comfy.Locale: "en", "zh", "zh-TW", "ja", ...)
// to one of our language codes. Anything unknown becomes English.
export function mapComfyLocale(locale) {
  const raw = String(locale ?? "").trim().replace(/_/g, "-");
  if (!raw) return FALLBACK_LANGUAGE;
  const lower = raw.toLowerCase();
  if (lower.startsWith("zh")) {
    return /(^|-)(tw|hk|mo|hant)(-|$)/.test(lower) ? "zh-TW" : "zh";
  }
  const base = lower.split("-")[0];
  return isSupportedLanguage(base) ? base : FALLBACK_LANGUAGE;
}

function lookup(code, key) {
  const lang = LANGUAGES.find((l) => l.code === code);
  const own = lang?.messages?.[key];
  if (typeof own === "string") return own;
  const base = LANGUAGES.find((l) => l.code === FALLBACK_LANGUAGE)?.messages?.[key];
  return typeof base === "string" ? base : key;
}

function interpolate(template, params, asHtml) {
  const source = asHtml ? escapeHtml(template) : template;
  return source.replace(/\{(\w+)\}/g, (match, name) => {
    if (!params || !Object.prototype.hasOwnProperty.call(params, name)) return match;
    const v = params[name];
    if (v && typeof v === "object" && typeof v.html === "string") {
      return asHtml ? v.html : v.text;
    }
    return asHtml ? escapeHtml(v) : String(v ?? "");
  });
}

// Returns { code, t, tHtml }.
//   t(key, params)     plain text (settings labels, option text, ...)
//   tHtml(key, params) HTML-safe: template and params are escaped, only
//                      bold()/code() wrappers emit markup. Also safe for
//                      attribute values.
export function createTranslator(code) {
  const lang = isSupportedLanguage(code) ? code : FALLBACK_LANGUAGE;
  return {
    code: lang,
    t: (key, params) => interpolate(lookup(lang, key), params, false),
    tHtml: (key, params) => interpolate(lookup(lang, key), params, true),
  };
}
