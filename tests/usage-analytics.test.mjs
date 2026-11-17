import assert from 'node:assert/strict';
import {
  USAGE_SOURCES,
  findUsedInventoryModels,
  findUnusedInventoryModels,
  findUsedCustomNodePackages,
  findUnusedCustomNodePackages,
} from '../web/js/usage-analytics.js';

assert.deepEqual(USAGE_SOURCES, ['frontend', 'api', 'unknown']);
const inventory = [
  { rel_path: 'checkpoints/base.safetensors', size_bytes: 100 },
  { rel_path: 'loras/detail.safetensors', size_bytes: 50 },
  { rel_path: 'vae/old.safetensors', size_bytes: 25 },
  { rel_path: 'checkpoints/unseen.safetensors', size_bytes: 10 },
  { rel_path: 'checkpoints/disabled.safetensors', size_bytes: 1, disabled: true },
];
const usageModels = [
  { model_id: 'checkpoints/base.safetensors', source_counts: { frontend: 3, api: 1 } },
  { model_id: 'loras/detail.safetensors', source_counts: { frontend: 0, api: 2 } },
  { model_id: 'vae/old.safetensors', source_counts: { unknown: 1 } },
];
assert.deepEqual(
  findUsedInventoryModels(inventory, usageModels, 'api').map((model) => model.rel_path),
  ['checkpoints/base.safetensors', 'loras/detail.safetensors'],
);
assert.deepEqual(
  findUnusedInventoryModels(inventory, usageModels, 'api').map((model) => model.rel_path),
  ['vae/old.safetensors', 'checkpoints/unseen.safetensors'],
);
assert.deepEqual(
  findUsedInventoryModels(inventory, usageModels, 'frontend').map((model) => model.rel_path),
  ['checkpoints/base.safetensors'],
);
assert.deepEqual(
  findUnusedInventoryModels(inventory, usageModels, 'all').map((model) => model.rel_path),
  ['checkpoints/unseen.safetensors'],
);
// A bare filename cannot be assigned to two different disk paths by guesswork.
const ambiguousInventory = [
  { rel_path: 'checkpoints/shared.safetensors' },
  { rel_path: 'loras/shared.safetensors' },
];
const ambiguousUsage = [{ model_id: 'shared.safetensors', source_counts: { frontend: 1 } }];
assert.equal(findUsedInventoryModels(ambiguousInventory, ambiguousUsage, 'frontend').length, 0);
assert.equal(findUnusedInventoryModels(ambiguousInventory, ambiguousUsage, 'frontend').length, 2);

const customPackages = [
  { id: 'pkg:Alpha', name: 'Alpha', execution_count: 3, extension_type: 'node_package' },
  { id: 'pkg:Beta', name: 'Beta', execution_count: 0, extension_type: 'both' },
  { id: 'pkg:Gamma', name: 'Gamma', execution_count: 0, extension_type: 'node_package' },
  { id: 'pkg:Ui', name: 'Ui', execution_count: 0, extension_type: 'ui_only' },
  { id: 'pkg:Disabled', name: 'Disabled', disabled: true, execution_count: 0, extension_type: 'node_package' },
];
const customUsage = [
  { package_id: 'pkg:Alpha', prompt_count: 2, source_counts: { frontend: 0, api: 2, unknown: 0 }, has_execution: true, execution_in_period: true },
  { package_id: 'pkg:Beta', prompt_count: 1, source_counts: { frontend: 1, api: 0, unknown: 0 }, has_execution: false, execution_in_period: false },
  { package_id: 'pkg:Gamma', prompt_count: 0, source_counts: { frontend: 0, api: 0, unknown: 0 }, has_execution: false, execution_in_period: false },
];
assert.deepEqual(
  findUsedCustomNodePackages(customPackages, customUsage, 'api', '7d').map((item) => item.id),
  ['pkg:Alpha'],
);
assert.deepEqual(
  findUnusedCustomNodePackages(customPackages, customUsage, 'api', '7d').map((item) => item.id),
  ['pkg:Beta', 'pkg:Gamma'],
);
assert.deepEqual(
  findUsedCustomNodePackages(customPackages, customUsage, 'all', '7d').map((item) => item.id),
  ['pkg:Alpha', 'pkg:Beta'],
);
assert.deepEqual(
  findUsedCustomNodePackages(customPackages, customUsage, 'all', 'all').map((item) => item.id),
  ['pkg:Alpha', 'pkg:Beta'],
);
console.log('usage source filter helper tests passed');
