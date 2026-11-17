// Package-level Custom Node Analytics navigation.
// The actual tables use the same renderer, column resizing, reordering and
// persisted table-layout settings as Model Analytics in main.js.
import { escapeHtml } from "./i18n/index.js";
import { findUsedCustomNodePackages, findUnusedCustomNodePackages } from "./usage-analytics.js";

export const CUSTOM_NODE_TABS = ["used", "unused", "disabled", "workflow"];

function isUiOnlyPackage(item) {
  return item?.extension_type === "ui_only";
}

function isPackageEligibleForUsage(item) {
  // Older cached responses did not carry extension_type. Treat those rows as
  // packages for backwards compatibility, but never classify a known UI-only
  // extension as an unused workflow-node package.
  return !isUiOnlyPackage(item);
}

export function getCustomNodeTabCounts(data, usageData = null, source = "all") {
  const packages = Array.isArray(data?.packages) ? data.packages : [];
  const workflows = Array.isArray(data?.workflows) ? data.workflows : [];
  const scanKnown = data?.settings?.scan_workflows !== false
    && data?.workflow_scan?.available !== false;
  const usageAvailable = usageData?.custom_node_usage_available !== false;
  return {
    used: usageAvailable ? findUsedCustomNodePackages(
      packages.filter(isPackageEligibleForUsage),
      usageData?.custom_packages || [],
      source,
      usageData?.period || "all",
    ).length : undefined,
    unused: usageAvailable ? findUnusedCustomNodePackages(
      packages.filter(isPackageEligibleForUsage),
      usageData?.custom_packages || [],
      source,
      usageData?.period || "all",
    ).length : undefined,
    disabled: packages.filter((item) => item.disabled === true).length,
    workflow: scanKnown ? workflows.length : undefined,
  };
}

export function renderCustomNodeTabs({ data, usageData = null, source = "all", activeTab, h }) {
  const counts = getCustomNodeTabCounts(data, usageData, source);
  return `
    <div class="ma-subtabs" role="tablist">
      ${CUSTOM_NODE_TABS.map((tab) => {
        const count = counts[tab];
        return `
          <button type="button" role="tab"
            class="ma-subtab-btn${tab === activeTab ? " active" : ""}"
            data-custom-node-tab="${tab}"
            aria-selected="${tab === activeTab ? "true" : "false"}">
            ${h(`custom.tab.${tab}`)}${count === undefined ? "" : `<span class="ma-tab-count">${escapeHtml(count)}</span>`}
          </button>
        `;
      }).join("")}
    </div>
  `;
}
