import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import { CodingPlanQuotaPanel } from "@/settings/usage-stats/CodingPlanQuotaPanel.js";

export function UsageStatsSection() {
  return (
    <div className="space-y-6">
      <AppUsagePanel />
      <div className="border-t border-border pt-5">
        <CodingPlanQuotaPanel />
      </div>
    </div>
  );
}
