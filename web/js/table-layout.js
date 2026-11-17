const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Validate a stored table layout against the columns that exist in this
 * dashboard version. Unknown/removed columns are discarded and newly added
 * columns are appended using their default widths.
 */
export function normalizeTableLayout(columns, stored = {}) {
  const ids = columns.map((column) => column.id);
  const validIds = new Set(ids);
  const requestedOrder = Array.isArray(stored?.order) ? stored.order : [];
  const order = [
    ...requestedOrder.filter((id, index) => validIds.has(id) && requestedOrder.indexOf(id) === index),
    ...ids.filter((id) => !requestedOrder.includes(id)),
  ];

  const storedWidths = stored?.widths && typeof stored.widths === "object" ? stored.widths : {};
  const rawWidths = {};
  for (const column of columns) {
    const value = Number(storedWidths[column.id]);
    rawWidths[column.id] = Number.isFinite(value) && value > 0 ? value : Number(column.width) || 1;
  }

  const total = Object.values(rawWidths).reduce((sum, value) => sum + value, 0) || 1;
  const widths = Object.fromEntries(
    ids.map((id) => [id, Math.round((rawWidths[id] / total) * 10000) / 100]),
  );
  // Avoid accumulated floating-point drift in the percentages.
  const widthSum = Object.values(widths).reduce((sum, value) => sum + value, 0);
  widths[ids[ids.length - 1]] = Math.round((widths[ids[ids.length - 1]] + 100 - widthSum) * 100) / 100;

  return { order, widths };
}

/** Move a column to the position occupied by the target column. */
export function reorderTableColumn(layout, sourceId, targetId, position = "before") {
  if (!layout || sourceId === targetId) return layout;
  const order = [...layout.order];
  const sourceIndex = order.indexOf(sourceId);
  if (sourceIndex < 0 || !order.includes(targetId)) return layout;
  order.splice(sourceIndex, 1);
  const targetIndex = order.indexOf(targetId);
  const insertIndex = targetIndex + (position === "after" ? 1 : 0);
  order.splice(insertIndex, 0, sourceId);
  return { order, widths: { ...layout.widths } };
}

/**
 * Resize one column and its immediate neighbour while keeping the table's
 * total width fixed. Positive delta widens the selected column. The last
 * column uses the preceding column as its neighbour.
 */
export function resizeAdjacentColumns(layout, columns, columnId, deltaPx, tableWidth) {
  if (!layout || !Number.isFinite(deltaPx) || !Number.isFinite(tableWidth) || tableWidth <= 0) {
    return layout;
  }
  const index = layout.order.indexOf(columnId);
  if (index < 0 || layout.order.length < 2) return layout;

  const neighbourIndex = index < layout.order.length - 1 ? index + 1 : index - 1;
  const neighbourId = layout.order[neighbourIndex];
  const currentId = layout.order[index];
  const pairTotal = layout.widths[currentId] + layout.widths[neighbourId];
  const deltaPercent = (deltaPx / tableWidth) * 100;
  const columnMap = new Map(columns.map((column) => [column.id, column]));
  const currentMinRaw = (Number(columnMap.get(currentId)?.minWidth) || 48) / tableWidth * 100;
  const neighbourMinRaw = (Number(columnMap.get(neighbourId)?.minWidth) || 48) / tableWidth * 100;
  // If the viewport is unusually narrow, scale the minimums so a resize can
  // never force the table beyond its available width.
  const minCurrent = Math.min(currentMinRaw, pairTotal * 0.42);
  const minNeighbour = Math.min(neighbourMinRaw, pairTotal * 0.42);
  const min = Math.min(minCurrent, pairTotal - minNeighbour);
  const max = Math.max(min, pairTotal - minNeighbour);
  const nextCurrent = clamp(layout.widths[currentId] + deltaPercent, min, max);
  const nextNeighbour = pairTotal - nextCurrent;

  return {
    order: [...layout.order],
    widths: {
      ...layout.widths,
      [currentId]: Math.round(nextCurrent * 100) / 100,
      [neighbourId]: Math.round(nextNeighbour * 100) / 100,
    },
  };
}


/**
 * Return the columns that own a visible resize handle. A table with N columns
 * has exactly N-1 boundaries, so the final visible column must not add a
 * second handle on the same boundary from its left side.
 */
export function getResizableColumnIds(order) {
  if (!Array.isArray(order) || order.length < 2) return [];
  return order.slice(0, -1);
}
