import assert from 'node:assert/strict';
import test from 'node:test';
import { CUSTOM_NODE_TABS, getCustomNodeTabCounts, renderCustomNodeTabs } from '../web/js/custom-node-analytics.js';

const messages = {
  'custom.tab.used': 'Used packages',
  'custom.tab.unused': 'Unused packages',
  'custom.tab.disabled': 'Disabled packages',
  'custom.tab.workflow': 'Workflows',
};
const h = (key) => messages[key] ?? key;

const data = {
  success: true,
  settings: { tracking_enabled: true, scan_workflows: true },
  workflow_scan: { available: true, workflow_count: 3 },
  summary: { package_count: 5, used_package_count: 1, unused_package_count: 2, disabled_package_count: 1, ui_only_package_count: 1 },
  packages: [
    { id: 'root0:Alpha', name: 'Alpha', disabled: false, execution_count: 8 },
    { id: 'root0:Beta', name: 'Beta', disabled: false, execution_count: 0 },
    { id: 'root0:Gamma', name: 'Gamma', disabled: false, execution_count: 0 },
    { id: 'root0:DashboardOnly', name: 'DashboardOnly', disabled: false, execution_count: 0, extension_type: 'ui_only' },
    { id: 'root0:OldPack.disabled', name: 'OldPack', disabled: true, execution_count: 0 },
  ],
  workflows: [
    { name: 'sample-a.json', package_count: 2, package_names_text: 'Alpha, Beta', node_type_count: 3 },
  ],
};
const usageData = {
  period: '7d',
  custom_packages: [
    { package_id: 'root0:Alpha', prompt_count: 2, source_counts: { frontend: 0, api: 2, unknown: 0 }, execution_count: 4, has_execution: true, execution_in_period: true },
  ],
};

test('Custom Node Analytics exposes package-level tabs only', () => {
  assert.deepEqual(CUSTOM_NODE_TABS, ['used', 'unused', 'disabled', 'workflow']);
  assert.deepEqual(getCustomNodeTabCounts(data), { used: 1, unused: 2, disabled: 1, workflow: 1 });
  const html = renderCustomNodeTabs({ data, activeTab: 'used', h });
  assert.match(html, /Used packages/);
  assert.match(html, /Unused packages/);
  assert.match(html, /Disabled packages/);
  assert.match(html, /Workflows/);
  assert.doesNotMatch(html, /overview|notRecorded|executed/);
});

test('workflow count is unknown when scanning is disabled or unavailable', () => {
  assert.equal(getCustomNodeTabCounts({
    ...data,
    settings: { scan_workflows: false },
  }).workflow, undefined);
  assert.equal(getCustomNodeTabCounts({
    ...data,
    workflow_scan: { available: false },
  }).workflow, undefined);
});

test('package tab counts exclude disabled packages from used and unused groups', () => {
  const counts = getCustomNodeTabCounts(data);
  assert.equal(counts.used, 1);
  assert.equal(counts.unused, 2);
  assert.equal(counts.disabled, 1);
});

test('package tab counts follow the shared time-window and usage-source filters', () => {
  assert.deepEqual(getCustomNodeTabCounts(data, usageData, 'api'), { used: 1, unused: 2, disabled: 1, workflow: 1 });
  assert.deepEqual(getCustomNodeTabCounts(data, usageData, 'frontend'), { used: 0, unused: 3, disabled: 1, workflow: 1 });
});

test('rendered package tabs use the same shared source and time-window counts', () => {
  const apiHtml = renderCustomNodeTabs({ data, usageData, source: 'api', activeTab: 'used', h });
  const frontendHtml = renderCustomNodeTabs({ data, usageData, source: 'frontend', activeTab: 'used', h });
  assert.match(apiHtml, /Used packages<span class="ma-tab-count">1<\/span>/);
  assert.match(frontendHtml, /Used packages<span class="ma-tab-count">0<\/span>/);
  assert.match(frontendHtml, /Unused packages<span class="ma-tab-count">3<\/span>/);
});

test('package tab counts are omitted when package usage analytics are unavailable', () => {
  const unavailable = { ...usageData, custom_node_usage_available: false };
  assert.deepEqual(getCustomNodeTabCounts(data, unavailable, 'api'), {
    used: undefined, unused: undefined, disabled: 1, workflow: 1,
  });
});

test('UI-only extensions are not counted as unused workflow-node packages', () => {
  const counts = getCustomNodeTabCounts(data);
  assert.equal(counts.used, 1);
  assert.equal(counts.unused, 2);
  assert.equal(counts.disabled, 1);
});


test('UI-only extensions are not rendered in a separate secondary package table', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../web/js/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /customUiOnly/);
  assert.doesNotMatch(source, /custom\.uiOnly\./);
});
