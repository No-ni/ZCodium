import { useEffect, useMemo, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveDefaultCatalogSelection,
  type ProviderModelCatalogItem,
} from "@/settings/model-provider-section/providerModelCatalogSelection.js";

export function ProviderModelCatalogDialog({
  open,
  providerName,
  items,
  loading = false,
  saving = false,
  hintMessage = null,
  errorMessage = null,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  providerName: string;
  items: readonly ProviderModelCatalogItem[];
  loading?: boolean;
  saving?: boolean;
  /** 预防性提示（如该端点可能不提供目录接口）；与 errorMessage 分开，避免被当成失败结果。 */
  hintMessage?: string | null;
  errorMessage?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (modelIds: readonly string[]) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());

  // 只在打开时清空排除项；部分添加成功会更新 items，不能因此重新勾选用户取消的模型。
  useEffect(() => {
    if (!open) return;
    setExcluded(new Set());
  }, [open]);

  const selectedIds = useMemo(
    () => resolveDefaultCatalogSelection(items).filter((modelId) => !excluded.has(modelId)),
    [items, excluded],
  );
  const busy = loading || saving;

  const toggle = (modelId: string, checked: boolean): void => {
    setExcluded((current) => {
      const next = new Set(current);
      if (checked) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.modelCatalog.dialogTitle" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage(
              { id: "settings.modelProvider.modelCatalog.dialogDescription" },
              { provider: providerName },
            )}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div
            className="flex items-center gap-2 py-8 text-ui-base text-foreground-subtle"
            role="status"
          >
            <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.modelProvider.modelCatalog.loading" })}
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.modelCatalog.empty" })}
          </p>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-input-border bg-input p-2">
            {items.map((item) => (
              <li key={item.modelId}>
                <label
                  className={
                    item.alreadyAdded
                      ? "flex cursor-not-allowed items-center gap-3 rounded-md px-2 py-1.5 text-ui-sm opacity-60"
                      : "flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-ui-sm hover:bg-surface-hover"
                  }
                >
                  <Checkbox
                    checked={item.alreadyAdded || !excluded.has(item.modelId)}
                    disabled={item.alreadyAdded || saving}
                    onCheckedChange={(checked) => toggle(item.modelId, checked === true)}
                    aria-label={item.modelId}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono">{item.modelId}</span>
                  {item.alreadyAdded ? (
                    <span className="text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({
                        id: "settings.modelProvider.modelCatalog.alreadyAdded",
                      })}
                    </span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
        )}
        {/* 预防性提示必须与失败结果并存：请求通常几毫秒就失败，
            若用 "hint && !error" 它会被 errorMessage 立刻挤掉，用户根本看不到。 */}
        {hintMessage ? (
          <p role="note" className="text-ui-sm text-foreground-subtle">
            {hintMessage}
          </p>
        ) : null}
        {errorMessage ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            disabled={busy || selectedIds.length === 0}
            onClick={() => void onConfirm(selectedIds)}
          >
            {intl.formatMessage(
              { id: "settings.modelProvider.modelCatalog.confirm" },
              { count: selectedIds.length },
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
