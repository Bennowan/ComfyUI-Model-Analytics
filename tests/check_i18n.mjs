import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LANGUAGES,
  FALLBACK_LANGUAGE,
  createTranslator,
  escapeHtml,
  isSupportedLanguage,
  mapComfyLocale,
} from '../web/js/i18n/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'web/js/main.js'), 'utf8');
const base = LANGUAGES.find((language) => language.code === FALLBACK_LANGUAGE)?.messages;
assert.ok(base, 'English fallback locale must exist');
const baseKeys = Object.keys(base).sort();
const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

const expectedCodes = ['en', 'de', 'zh', 'zh-TW', 'ja', 'ko'];
assert.deepEqual(LANGUAGES.map(({ code }) => code), expectedCodes);

for (const language of LANGUAGES) {
  const messages = language.messages;
  const keys = Object.keys(messages).sort();
  assert.deepEqual(keys, baseKeys, `${language.code}: translation keys must match English`);
  for (const key of baseKeys) {
    assert.equal(typeof messages[key], 'string', `${language.code}.${key}: value must be a string`);
    assert.ok(messages[key].trim(), `${language.code}.${key}: translation must not be empty`);
    assert.deepEqual(
      placeholders(messages[key]),
      placeholders(base[key]),
      `${language.code}.${key}: interpolation placeholders must match English`,
    );
  }
}

const literalKeys = new Set();
for (const match of mainSource.matchAll(/(?:\.h|\.t|headerCell)\(\s*['"]([\w.]+)['"]/g)) {
  literalKeys.add(match[1]);
}
for (const key of literalKeys) {
  assert.ok(key in base, `main.js references missing translation key: ${key}`);
}
for (const key of [
  'tab.used', 'tab.unused', 'tab.disabled', 'tab.workflow', 'tab.settings',
  'settings.group.appearance', 'settings.theme.name', 'settings.theme.tooltip',
  'settings.theme.auto', 'settings.theme.dark', 'settings.theme.light',
  'settings.panel.description', 'settings.saveError',
  'reason.recent_load', 'reason.recent_queue', 'reason.workflow_reference',
  'used.empty.window', 'used.empty.all', 'used.summary.window', 'used.summary.all',
  'unused.summary.window', 'unused.summary.all',
  'action.open', 'settings.group.recency',
  'settings.recency.enabled.name', 'settings.recency.enabled.tooltip',
  'settings.recency.days.name', 'settings.recency.days.tooltip',
]) {
  assert.ok(key in base, `dynamic translation key must exist: ${key}`);
}

const localeCases = new Map([
  ['en', 'en'], ['en-US', 'en'], ['de', 'de'], ['de-DE', 'de'],
  ['zh', 'zh'], ['zh-CN', 'zh'], ['zh-Hans', 'zh'], ['zh_TW', 'zh-TW'],
  ['zh-Hant', 'zh-TW'], ['zh-HK', 'zh-TW'], ['ja', 'ja'], ['ja-JP', 'ja'],
  ['ko', 'ko'], ['ko-KR', 'ko'], ['fr', 'en'], ['pt-BR', 'en'], ['', 'en'],
]);
for (const [input, expected] of localeCases) {
  assert.equal(mapComfyLocale(input), expected, `locale mapping for ${input}`);
}
assert.equal(mapComfyLocale(undefined), 'en');
assert.equal(isSupportedLanguage('zh-TW'), true);
assert.equal(isSupportedLanguage('zh-HK'), false);
assert.equal(createTranslator('not-a-language').code, 'en');

assert.equal(escapeHtml('<script a="b">&\'x\'</script>'), '&lt;script a=&quot;b&quot;&gt;&amp;&#39;x&#39;&lt;/script&gt;');
const translator = createTranslator('de');
const safe = translator.tHtml('workflow.noModels', { name: '<img src=x onerror=alert(1)>' });
assert.ok(!safe.includes('<img'), 'untrusted interpolation must be HTML-escaped');
assert.ok(safe.includes('&lt;img'), 'escaped markup must remain visible as text');
const marked = translator.tHtml('disabled.summary', {
  count: { text: '4', html: '<b>4</b>' },
  suffix: { text: '.disabled', html: '<code>.disabled</code>' },
  size: { text: '2 GiB', html: '<b>2 GiB</b>' },
});
assert.ok(marked.includes('<b>4</b>'));
assert.ok(marked.includes('<code>.disabled</code>'));
assert.ok(!marked.includes('<img'));

assert.ok(mainSource.includes('const DATA_TABS = ["used", "unused", "disabled", "workflow"]'), 'settings tab must not become a data default tab');
assert.ok(mainSource.includes('this.activeTab === "settings"'), 'dashboard must render its in-dashboard settings tab');
assert.ok(mainSource.includes('this.attachSettingsHandlers(overlay.querySelector(".ma-body"))'), 'settings controls must use a persistent delegated handler');
assert.ok(mainSource.includes('ModelAnalytics.Theme'), 'dashboard theme must be a persisted ComfyUI setting');
const css = fs.readFileSync(path.join(projectRoot, 'web/css/style.css'), 'utf8');
assert.ok(css.includes('.ma-overlay[data-ma-theme="dark"]'), 'dark dashboard override must exist');
assert.ok(css.includes('.ma-overlay[data-ma-theme="light"]'), 'light dashboard override must exist');
assert.ok(css.includes('.ma-settings-page'), 'settings tab must have dedicated styling');


// Entry points: new ComfyUI menu (Extensions menu + action bar) plus the
// legacy-menu fallback button.
assert.ok(mainSource.includes('menuCommands: ['), 'menu entry must be registered');
assert.ok(mainSource.includes('path: ["Extensions"]'), 'menu entry must live under Extensions');
assert.ok(mainSource.includes('actionBarButtons,'), 'action bar button must be registered');
assert.ok(mainSource.includes('function addLegacyMenuButton()'), 'legacy menu fallback button must exist');

// Recency window lives in the ComfyUI settings; localStorage is only read
// (and cleared) once for the migration, never written.
assert.ok(mainSource.includes('ModelAnalytics.RecencyEnabled') && mainSource.includes('ModelAnalytics.RecencyDays'), 'recency settings must be registered');
assert.ok(mainSource.includes('migrateLegacyLocalPreferences'), 'legacy localStorage migration must exist');
assert.ok(!/localStorage\.setItem/.test(mainSource), 'main.js must not write to localStorage');

// Language: a manual choice is only ever written by the user's own action.
assert.ok(!/writeSetting\(\s*SETTING\.language/.test(mainSource), 'the language setting must never be written automatically');

// Read-only by design: no delete/remove functionality anywhere in the frontend.
const sourcesToScan = [mainSource, fs.readFileSync(path.join(projectRoot, 'web/js/i18n/index.js'), 'utf8')];
for (const source of sourcesToScan) {
  assert.ok(!/method:\s*['"](DELETE|POST|PUT|PATCH)['"]/i.test(source), 'frontend must only issue read requests');
  assert.ok(!/\bunlink\b|\brmtree\b|\bremoveFile\b|deleteModel/i.test(source), 'no delete functionality allowed');
}
for (const [code, messages] of LANGUAGES.map((l) => [l.code, l.messages])) {
  for (const [key, value] of Object.entries(messages)) {
    assert.ok(!/\b(delete|trash)\b|löschen|删除|刪除|削除|삭제/i.test(value), `${code}.${key}: no delete wording in the UI text`);
  }
}

// Python side: no environment variable access, no deletion, no network or
// process access (keeps the scanner-compatibility fixes intact).
for (const file of ['__init__.py', 'api_server.py', 'scanner.py', 'tracker.py']) {
  const py = fs.readFileSync(path.join(projectRoot, file), 'utf8');
  assert.ok(!/os\.environ|getenv|environ\[/.test(py), `${file}: must not read environment variables`);
  assert.ok(!/subprocess|os\.system|shutil\.rmtree|os\.remove|os\.unlink|\.unlink\(|rmdir|eval\(|exec\(/.test(py), `${file}: no process or delete calls allowed`);
}

// Styles: semantic tokens only, no hard-coded colour palette.
assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'style.css must not contain hex colour values');
assert.ok(css.includes('--ma-accent-text'), 'readable accent text token must exist');
assert.ok(css.includes('CanvasText') && css.includes('AccentColor'), 'explicit themes must use CSS system colours');
assert.ok(!css.includes('--primary-foreground') && !css.includes('var(--success'), 'tokens that ComfyUI does not define must not be referenced');

console.log(`i18n and dashboard settings checks passed: ${LANGUAGES.length} locales, ${baseKeys.length} keys each, locale mapping, escaping, settings wiring and theme overrides verified.`);
