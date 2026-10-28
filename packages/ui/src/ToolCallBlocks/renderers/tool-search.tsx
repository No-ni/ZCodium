import { SearchIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

const ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

function readQuery(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const query = (input as Record<string, unknown>).query;
  return typeof query === "string" ? query : undefined;
}

export function ToolSearchToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const parsed = readToolResultDisplay(toolCall.raw);
  // 只消费权威成功 display；失败/拒绝/取消不能从旧输出猜出一次“搜索成功”。
  const display =
    toolCall.status === "completed" && parsed?.kind === "tool_search" ? parsed : undefined;
  const query = display?.query ?? readQuery(toolCall.input) ?? "ToolSearch";
  const statusLabel = display
    ? intl.formatMessage(
        { id: "chat.toolCall.toolSearch.matches" },
        { count: display.totalMatches },
      )
    : context.statusLabel;
  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={ICON}
        showIcon={context.showIcon !== false}
        canToggle={Boolean(display) && (context.canToggle ?? true)}
        forceOpen={Boolean(display) && (context.forceOpen ?? false)}
        kindLabel={
          context.kindLabelOverride ??
          intl.formatMessage({
            id: context.isRunning
              ? "chat.toolCall.toolSearch.searching"
              : "chat.toolCall.toolSearch.searched",
          })
        }
        sourceLabel={context.sourceLabel}
        primaryText={
          <span className="min-w-0 truncate" title={query}>
            {query}
          </span>
        }
        statusLabel={statusLabel}
        showStatusLabel
        statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={
          display
            ? () => (
                <div
                  className="min-w-0 rounded-lg border border-border bg-surface px-4 py-3"
                  data-testid="tool-search-results"
                >
                  {display.matches.length ? (
                    <ul className="max-h-48 space-y-1 overflow-auto text-ui-base text-foreground-subtle">
                      {display.matches.map((name, index) => (
                        <li key={`${index}:${name}`} className="break-words font-mono">
                          {name}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-ui-base text-foreground-subtle">
                      {intl.formatMessage({ id: "chat.toolCall.toolSearch.noMatches" })}
                    </p>
                  )}
                  {display.truncated ? (
                    <p className="mt-2 text-ui-sm text-foreground-subtle">
                      {intl.formatMessage(
                        { id: "chat.toolCall.toolSearch.truncated" },
                        { count: display.matches.length, total: display.totalMatches },
                      )}
                    </p>
                  ) : null}
                </div>
              )
            : undefined
        }
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
