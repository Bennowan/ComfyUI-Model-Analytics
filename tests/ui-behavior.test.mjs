import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const main = await readFile(new URL('web/js/main.js', root), 'utf8');
const css = await readFile(new URL('web/css/style.css', root), 'utf8');

 test('modern action bar uses one custom-styled native entry point', () => {
  assert.match(main, /class: "ma-actionbar-button"/);
  assert.match(main, /button\.class = "ma-actionbar-button"/);
  assert.match(css, /button\.ma-actionbar-button\s*\{/);
  assert.match(main, /if \(!legacyMenuInUse\(\)\) \{[\s\S]*?actionBarButtons\.push/);
 });

test('tables are fixed to their available width and use a themed vertical scrollbar', () => {
  assert.match(css, /table\.ma-table\s*\{[\s\S]*?table-layout:\s*fixed/);
  assert.match(css, /\.ma-table-scroll\s*\{[\s\S]*?overflow-x:\s*hidden[\s\S]*?overflow-y:\s*auto/);
  assert.match(css, /\.ma-table-scroll::?-webkit-scrollbar-thumb/);
  assert.match(css, /scrollbar-color:/);
 });

test('column layouts are persisted separately for each table', () => {
  assert.match(main, /SETTING\.tableLayout/);
  assert.match(main, /writeSetting\(SETTING\.tableLayout/);
  assert.doesNotMatch(main, /localStorage\.setItem/);
  assert.match(main, /reorderTableColumn/);
  assert.match(main, /resizeAdjacentColumns/);
 });
