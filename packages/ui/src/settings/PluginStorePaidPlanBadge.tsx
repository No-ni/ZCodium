import { Crown } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";

/**
 * 付费套餐提示：目录条目声明 `listing.requiresPaidPlan` 时，在标题右侧展示渐变徽标。
 * 表达的是「需要付费套餐才好用」这个使用条件，不是「插件是收费商品」——不做安装门禁。
 * 商店卡片与详情页标题共用同一渐变徽标。
 * 徽标使用短文案，完整条件由 Tooltip 和 aria-label 表达；缺字段时整个标记不渲染。
 * hover 提示走 ControlHintTooltip（Root Provider 的 delayDuration=0，即时弹出），
 * 不用原生 title——后者有约 1s 系统延迟。
 */
export function PluginStorePaidPlanBadge({
  item,
}: {
  item: Pick<StorePluginItem, "id" | "listing">;
}) {
  const { intl } = useZCodeIntl();
  if (!item.listing?.requiresPaidPlan) return null;
  const label = intl.formatMessage({ id: "settings.plugins.store.requiresPaidPlan" });
  const badgeLabel = intl.formatMessage({ id: "settings.plugins.store.paidPlanBadge" });
  return (
    <ControlHintTooltip title={label}>
      <span
        data-testid="plugin-store-paid-plan-badge"
        data-plugin-id={item.id}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-plugin-paid-plan-badge)] px-1.5 py-0.5 text-ui-sm leading-none whitespace-nowrap text-[var(--color-plugin-paid-plan-badge-foreground)]"
        aria-label={label}
      >
        <Crown className="size-3" aria-hidden="true" />
        {badgeLabel}
      </span>
    </ControlHintTooltip>
  );
}
