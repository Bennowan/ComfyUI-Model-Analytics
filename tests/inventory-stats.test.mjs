import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateInventoryStats } from '../web/js/inventory-stats.js';

test('classifications and size totals use the same inventory snapshot', () => {
  const models = [
    { name: 'used', size_bytes: 100, unused: false, disabled: false },
    { name: 'unused-a', size_bytes: 200, unused: true, disabled: false },
    { name: 'unused-b', size_bytes: 300, unused: true, disabled: false },
    { name: 'disabled', size_bytes: 400, unused: false, disabled: true },
  ];
  const stats = calculateInventoryStats(models);
  assert.deepEqual(stats.used.map((m) => m.name), ['used']);
  assert.deepEqual(stats.unused.map((m) => m.name), ['unused-a', 'unused-b']);
  assert.deepEqual(stats.disabled.map((m) => m.name), ['disabled']);
  assert.equal(stats.unusedBytes, 500);
  assert.equal(stats.usedBytes, 100);
  assert.equal(stats.disabledBytes, 400);
});

test('a model moving from unused to used decreases the unused total', () => {
  const before = calculateInventoryStats([{ size_bytes: 1024, unused: true }]);
  const after = calculateInventoryStats([{ size_bytes: 1024, unused: false }]);
  assert.equal(before.unused.length, 1);
  assert.equal(before.unusedBytes, 1024);
  assert.equal(after.unused.length, 0);
  assert.equal(after.unusedBytes, 0);
  assert.equal(after.used.length, 1);
});

test('invalid sizes and non-arrays are handled safely', () => {
  assert.equal(calculateInventoryStats([{ size_bytes: -5 }, { size_bytes: 'bad' }]).usedBytes, 0);
  assert.equal(calculateInventoryStats(null).used.length, 0);
});
