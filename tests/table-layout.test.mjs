import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeTableLayout,
  reorderTableColumn,
  resizeAdjacentColumns,
} from '../web/js/table-layout.js';

const columns = [
  { id: 'name', width: 50, minWidth: 140 },
  { id: 'size', width: 25, minWidth: 70 },
  { id: 'last', width: 25, minWidth: 90 },
];

test('normalizes saved order and widths and appends newly added columns', () => {
  const layout = normalizeTableLayout(columns, {
    order: ['size', 'removed', 'name', 'size'],
    widths: { name: 60, size: 20, removed: 999 },
  });
  assert.deepEqual(layout.order, ['size', 'name', 'last']);
  assert.ok(Math.abs(Object.values(layout.widths).reduce((a, b) => a + b, 0) - 100) < 0.01);
  assert.ok(layout.widths.last > 0);
});

test('reorders columns without changing their widths', () => {
  const layout = normalizeTableLayout(columns);
  const moved = reorderTableColumn(layout, 'last', 'name');
  assert.deepEqual(moved.order, ['last', 'name', 'size']);
  assert.deepEqual(moved.widths, layout.widths);
});

test('supports dropping a column after the target column', () => {
  const layout = normalizeTableLayout(columns);
  const moved = reorderTableColumn(layout, 'name', 'last', 'after');
  assert.deepEqual(moved.order, ['size', 'last', 'name']);
});

test('resizes adjacent columns without changing their combined width', () => {
  const layout = normalizeTableLayout(columns);
  const resized = resizeAdjacentColumns(layout, columns, 'name', 100, 1000);
  assert.ok(resized.widths.name > layout.widths.name);
  assert.ok(resized.widths.size < layout.widths.size);
  assert.equal(
    Math.round((resized.widths.name + resized.widths.size) * 100) / 100,
    Math.round((layout.widths.name + layout.widths.size) * 100) / 100,
  );
});

test('invalid resize inputs safely preserve the previous layout', () => {
  const layout = normalizeTableLayout(columns);
  assert.equal(resizeAdjacentColumns(layout, columns, 'name', 10, 0), layout);
  assert.equal(resizeAdjacentColumns(layout, columns, 'missing', 10, 1000), layout);
});
