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
  assert.ok(!('tab.usage' in messages), `${language.code}: the standalone Usage tab label must be removed`);
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
  'header.source.label', 'header.source.tooltip', 'usage.filter.loading', 'usage.filter.error',
  'used.summary.source.window', 'used.summary.source.all', 'unused.summary.source.window', 'unused.summary.source.all',
  'usage.source.all', 'usage.source.frontend', 'usage.source.api', 'usage.source.unknown', 'usage.noModels',
  'section.models', 'section.customNodes', 'section.settings',
  'settings.group.models', 'settings.group.modelsNote', 'settings.group.customNodes', 'settings.group.customNodesNote',
  'settings.defaultSection.name', 'settings.defaultSection.tooltip',
  'settings.customNodes.tracking.name', 'settings.customNodes.tracking.tooltip',
  'settings.customNodes.scan.name', 'settings.customNodes.scan.tooltip',
  'settings.customNodes.storageNote', 'settings.customNodes.syncError',
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

assert.ok(mainSource.includes('const EXT_VERSION = "156"'), 'frontend asset cache version must be bumped for the Analytics dashboard');
assert.ok(mainSource.includes('const DATA_TABS = ["used", "unused", "disabled", "workflow"]'), 'Usage must not become a separate dashboard tab');
assert.ok(mainSource.includes('fetch(`/model_analytics/usage?period='), 'source filter must fetch source-aware model usage');
assert.ok(mainSource.includes('.ma-source-filter-select'), 'usage source must be selected from the dashboard header');
assert.ok(mainSource.includes('findUsedInventoryModels') && mainSource.includes('findUnusedInventoryModels'), 'source filter must apply to existing Used and Unused tabs');
assert.ok(mainSource.includes('findUsedCustomNodePackages') && mainSource.includes('findUnusedCustomNodePackages'), 'global source and recency filters must apply to package-level Custom Node tabs');
assert.ok(!mainSource.includes('renderUsageTab') && !mainSource.includes('this.activeTab === "usage"'), 'standalone Usage tab UI must be removed');
assert.ok(mainSource.includes('this.activeSection === "settings"'), 'dashboard must render its in-dashboard Settings section');
assert.ok(mainSource.includes('const TABS = ["models", "customNodes", "settings"]'), 'dashboard must expose Models, Custom Nodes and Settings as primary sections');
assert.ok(mainSource.includes('renderCustomNodeTabs') && mainSource.includes('this.renderDataTable("customUsed"'), 'Custom Node Analytics must use the shared package table renderer');
assert.ok(mainSource.includes('sharedUsageControls.hidden = !["models", "customNodes"].includes(this.activeSection)'), 'shared usage controls must be visible in both analytics sections');
assert.ok(mainSource.includes('await this.refreshSourceUsage({ render: false });') && mainSource.includes('this.activeSection === "customNodes"'), 'the global recency window must refresh package usage while Custom Nodes is active');
assert.ok(mainSource.includes('usageData: this.sourceUsageData') && mainSource.includes('source: this.usageSourceFilter'), 'Custom Node tab counts must use shared source and time-window filters');
assert.ok(mainSource.includes('this.attachSettingsHandlers(body)'), 'settings controls must use a persistent delegated handler');
assert.ok(mainSource.includes('ModelAnalytics.Appearance'), 'dashboard appearance preference must be persisted');
const css = fs.readFileSync(path.join(projectRoot, 'web/css/style.css'), 'utf8');
assert.ok(css.includes('.ma-theme-grid'), 'ComfyUI palette choices must have a dedicated picker');
assert.ok(css.includes('--ma-custom-bg'), 'custom appearance must be scoped to the dashboard');
assert.ok(css.includes('.ma-settings-page'), 'settings tab must have dedicated styling');
assert.ok(css.includes('.ma-source-filter-select'), 'inline source filter must have dedicated styling');
assert.ok(!css.includes('.ma-usage-content'), 'standalone Usage dashboard styling must be removed');
assert.ok(css.includes('.ma-body.ma-body-settings') && css.includes('width: 100%') && css.includes('height: 100%'), 'settings page and its scrollbar must occupy the full modal content width and height');
assert.ok(mainSource.includes('cache: "no-store"'), 'inventory refresh must bypass browser caching');
assert.ok(mainSource.includes('"execution_start", "execution_success"'), 'inventory must refresh when execution starts and finishes');
assert.ok(mainSource.includes('id: SETTING.starBannerDismissed') && mainSource.includes('type: "hidden"'), 'star banner dismissal must not be a visible toggle');
assert.ok(mainSource.includes('starBanner: readSetting(SETTING.starBannerDismissed, false) !== true'), 'star banner must be shown by default on first install');
assert.ok(mainSource.includes('ma-menu-btn-icon'), 'legacy Model Analytics menu button must use its custom icon treatment');


// Exactly one visible Model Analytics entry is registered per ComfyUI menu
// mode. The legacy menu uses the styled button; modern mode uses action bar.
assert.ok(mainSource.includes('optionsHtml(options, value)'), 'appearance select renderer must exist on the dashboard');
assert.ok(mainSource.includes('renderSettingSelect(id, titleKey, tooltipKey, value)'), 'settings select renderer must exist on the dashboard');
assert.ok(mainSource.includes('if (!legacyMenuInUse())'), 'modern action bar entry must be gated to modern menu mode');
assert.ok(mainSource.includes('if (legacyMenuInUse()) addLegacyMenuButton();'), 'legacy button must be gated to legacy menu mode');
assert.ok(mainSource.includes('actionBarButtons,'), 'modern action bar button must be registered');
assert.ok(mainSource.includes('function addLegacyMenuButton()'), 'legacy menu button must exist');
assert.ok(!mainSource.includes('menuCommands: ['), 'Extensions menu command must not create a duplicate visible entry');
assert.ok(mainSource.includes("[data-ma-menu-button='true']"), 'legacy button setup must remove stale duplicate instances');

// Recency window lives in the ComfyUI settings; localStorage is only read
// (and cleared) once for the migration, never written.
assert.ok(mainSource.includes('ModelAnalytics.RecencyEnabled') && mainSource.includes('ModelAnalytics.RecencyDays'), 'recency settings must be registered');
assert.ok(mainSource.includes('migrateLegacyLocalPreferences'), 'legacy localStorage migration must exist');
assert.ok(!/localStorage\.setItem/.test(mainSource), 'main.js must not write to localStorage');

// Language: a manual choice is only ever written by the user's own action.
assert.ok(!/writeSetting\(\s*SETTING\.language/.test(mainSource), 'the language setting must never be written automatically');

// Analytics data is read-only; the sole write request synchronizes two custom-node tracking preferences.
const sourcesToScan = [mainSource, fs.readFileSync(path.join(projectRoot, 'web/js/i18n/index.js'), 'utf8')];
for (const source of sourcesToScan) {
  assert.ok(!/method:\s*['"](DELETE|PUT|PATCH)['"]/i.test(source), 'frontend must not expose destructive or general write requests');
  assert.ok(!/\bunlink\b|\brmtree\b|\bremoveFile\b|deleteModel/i.test(source), 'no delete functionality allowed');
}
const frontendWriteMethods = [...mainSource.matchAll(/method:\s*['"]([A-Z]+)['"]/gi)].map((match) => match[1].toUpperCase());
assert.deepEqual(frontendWriteMethods, ['POST'], 'only the custom-node settings synchronization may use POST');
assert.ok(mainSource.includes('/model_analytics/custom_nodes/settings'), 'custom-node preferences must sync to their dedicated settings endpoint');
for (const [code, messages] of LANGUAGES.map((l) => [l.code, l.messages])) {
  for (const [key, value] of Object.entries(messages)) {
    assert.ok(!/\b(delete|trash)\b|löschen|删除|刪除|削除|삭제/i.test(value), `${code}.${key}: no delete wording in the UI text`);
  }
}

// Python side: no environment variable access, no deletion, no network or
// process access (keeps the scanner-compatibility fixes intact).
for (const file of ['__init__.py', 'api_server.py', 'scanner.py', 'tracker.py', 'custom_node_analytics.py']) {
  const py = fs.readFileSync(path.join(projectRoot, file), 'utf8');
  assert.ok(!/os\.environ|getenv|environ\[/.test(py), `${file}: must not read environment variables`);
  assert.ok(!/subprocess|os\.system|shutil\.rmtree|os\.remove|os\.unlink|\.unlink\(|rmdir|eval\(|exec\(/.test(py), `${file}: no process or delete calls allowed`);
}

// Styles: semantic tokens only, no hard-coded colour palette.
assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'style.css must not contain hex colour values');
assert.ok(css.includes('--ma-accent-text'), 'readable accent text token must exist');
assert.ok(css.includes('CanvasText') && css.includes('AccentColor'), 'explicit themes must use CSS system colours');
assert.ok(!css.includes('--primary-foreground') && !css.includes('var(--success'), 'tokens that ComfyUI does not define must not be referenced');

console.log(`i18n and dashboard checks passed: ${LANGUAGES.length} locales, ${baseKeys.length} keys each, locale mapping, escaping, settings, layout, inventory refresh and appearance wiring verified.`);


assert.ok(!mainSource.includes("customUiOnly"), 'the secondary UI-only package table must be removed');
assert.ok(!mainSource.includes("custom.uiOnly."), 'the UI-only explanatory block must be removed');
assert.ok(!css.includes('table.ma-table th:last-child .ma-col-resizer'), 'the final header must not create a duplicate resize handle on its left edge');
assert.match(mainSource, /getResizableColumnIds\(ordered\.map\(\(column\) => column\.id\)\)/, 'resize handles must be generated from displayed column order');
assert.match(mainSource, /hasResizeHandle \? `<span class=\"ma-col-resizer\"/, 'the final displayed column must omit its resize handle');
