export const USAGE_SOURCES = ["frontend", "api", "unknown"];

function normalizePath(value) {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function filterUsageModels(models = [], source = "all") {
  const validSource = source === "all" || USAGE_SOURCES.includes(source) ? source : "all";
  return (Array.isArray(models) ? models : [])
    .filter((model) => model && typeof model === "object")
    .filter((model) => {
      if (validSource === "all") return USAGE_SOURCES.some((id) => Number(model.source_counts?.[id]) > 0);
      return Number(model.source_counts?.[validSource]) > 0;
    });
}

function buildUsagePathIndex(usageModels, source) {
  const paths = new Set();
  const bareNames = new Set();
  for (const model of filterUsageModels(usageModels, source)) {
    const id = normalizePath(model.model_id);
    if (!id) continue;
    paths.add(id);
    const parts = id.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      paths.add(parts.slice(index).join("/"));
    }
    if (parts.length === 1) bareNames.add(parts[0]);
  }
  return { paths, bareNames };
}

function buildInventoryMatch(inventory, usageModels, source) {
  const models = (Array.isArray(inventory) ? inventory : [])
    .filter((model) => model && !model.disabled && model.rel_path);
  const basenameCounts = new Map();
  for (const model of models) {
    const basename = normalizePath(model.rel_path).split("/").pop();
    basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
  }
  const { paths, bareNames } = buildUsagePathIndex(usageModels, source);
  const matches = (model) => {
    const relPath = normalizePath(model.rel_path);
    const basename = relPath.split("/").pop();
    if (paths.has(relPath)) return true;
    return bareNames.has(basename) && basenameCounts.get(basename) === 1;
  };
  return { models, matches };
}

export function findUsedInventoryModels(inventory = [], usageModels = [], source = "all") {
  const { models, matches } = buildInventoryMatch(inventory, usageModels, source);
  return models.filter(matches);
}

export function findUnusedInventoryModels(inventory = [], usageModels = [], source = "all") {
  const { models, matches } = buildInventoryMatch(inventory, usageModels, source);
  return models.filter((model) => !matches(model));
}

function buildCustomPackageUsageIndex(usagePackages = []) {
  const index = new Map();
  for (const item of Array.isArray(usagePackages) ? usagePackages : []) {
    if (!item || typeof item !== "object" || typeof item.package_id !== "string") continue;
    index.set(item.package_id, item);
  }
  return index;
}

function customPackageMatchesSource(item, usage, source, period) {
  if (source !== "all") {
    return Number(usage?.source_counts?.[source] || 0) > 0;
  }
  // Prompt presence is collected only for packages reachable from ComfyUI's
  // validated output targets. The separate execution_count remains a count of
  // successful, non-cached node steps; these two signals must not be conflated.
  return Number(usage?.prompt_count || 0) > 0
    || usage?.execution_in_period === true
    || (period === "all" && usage?.has_execution === true)
    || (!usage && Number(item?.execution_count || 0) > 0);
}

function eligibleCustomPackages(packages = []) {
  return (Array.isArray(packages) ? packages : []).filter((item) => item
    && !item.disabled
    && item.extension_type !== "ui_only");
}

export function findUsedCustomNodePackages(packages = [], usagePackages = [], source = "all", period = "all") {
  const usageByPackage = buildCustomPackageUsageIndex(usagePackages);
  return eligibleCustomPackages(packages).filter((item) =>
    customPackageMatchesSource(item, usageByPackage.get(item.id), source, period));
}

export function findUnusedCustomNodePackages(packages = [], usagePackages = [], source = "all", period = "all") {
  const usageByPackage = buildCustomPackageUsageIndex(usagePackages);
  return eligibleCustomPackages(packages).filter((item) =>
    !customPackageMatchesSource(item, usageByPackage.get(item.id), source, period));
}
