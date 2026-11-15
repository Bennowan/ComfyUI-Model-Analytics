// Derives model classifications and their disk totals from one inventory snapshot.
// This keeps tab counters and space summaries consistent with each other.
export function calculateInventoryStats(models = []) {
  const result = {
    used: [],
    unused: [],
    disabled: [],
    usedBytes: 0,
    unusedBytes: 0,
    disabledBytes: 0,
  };
  for (const model of Array.isArray(models) ? models : []) {
    if (!model || typeof model !== "object") continue;
    const bytes = Math.max(0, Number(model.size_bytes) || 0);
    if (model.disabled) {
      result.disabled.push(model);
      result.disabledBytes += bytes;
    } else if (model.unused) {
      result.unused.push(model);
      result.unusedBytes += bytes;
    } else {
      result.used.push(model);
      result.usedBytes += bytes;
    }
  }
  return result;
}
