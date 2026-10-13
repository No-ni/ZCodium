import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, Loader2Icon, Undo2Icon } from "lucide-react";
import type {
  CommandAck,
  ConversationRowTarget,
  TurnHeaderRow,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayInline, resolveFileDisplayBasePath } from "@/lib/fileDisplay.js";
import { resolveToolCallFilePath } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { buildChangeSummaryFilePreviewSource } from "@/messageChangeSummaryPreview.js";
import { OpenSplitButton } from "@/OpenSplitButton.js";
import { logger } from "@/logger.js";
import { ConversationFileRewindDialog } from "@/v4/ConversationFileRewindDialog.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";

type FileChangeItem = V4ConversationFileChangesResult["items"][number];

interface ConversationFileSummaryPanelProps {
  header: TurnHeaderRow;
  context: ConversationRowRenderContext;
}

function formatPatch(path: string, patches: FileChangeItem["patches"]): string {
  if (patches.length === 0) return "";
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const patch of patches) {
    lines.push(
      `@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@`,
      ...patch.lines,
    );
  }
  return lines.join("\n");
}

function openDiff(
  item: FileChangeItem,
  context: Pick<
    ConversationRowRenderContext,
    | "workspacePath"
    | "fileSearchRootPath"
    | "workspaceIdentity"
    | "workspaceRemoteSessionId"
    | "onOpenCodeViewer"
  >,
) {
  const patch = formatPatch(item.path, item.patches);
  const { workspacePath, workspaceIdentity, workspaceRemoteSessionId, onOpenCodeViewer } = context;
  if (!patch || !onOpenCodeViewer) return;
  // `item.path` 是模型写进 write/edit 的**原文**（可为相对路径，基准是它当时的执行 cwd）。
  // 展示标题按最深包含根算；读取/打开路径必须按模型 cwd 解析，否则 diff tab 的「查看源文件」
  // 会把相对路径拼到工作区身份根上（对话会话下指向对话根的同名文件或不存在）。
  const readablePath = readSummaryFilePath(item.path, context);
  const displayBasePath =
    resolveFileDisplayBasePath(item.path, [context.fileSearchRootPath, workspacePath]) ??
    workspacePath;
  const relativePath = toWorkspaceRelativePath(displayBasePath, item.path);
  onOpenCodeViewer({
    type: "patch",
    title: relativePath,
    path: readablePath,
    patch,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
  });
}

/**
 * 文件变更项里「真去读」的路径：`item.path` 是模型写的原文（相对路径的基准是会话执行 cwd），
 * 读取/打开必须按它解析；展示仍走 `resolveFileDisplayBasePath`（见 spec 规则 11/12）。
 */
function readSummaryFilePath(
  path: string,
  context: Pick<ConversationRowRenderContext, "workspacePath" | "fileSearchRootPath">,
): string {
  return resolveToolCallFilePath(path, context.fileSearchRootPath ?? context.workspacePath);
}

export function ConversationFileSummaryPanel({
  header,
  context,
}: ConversationFileSummaryPanelProps) {
  const { intl } = useZCodeIntl();
  const summary = header.fileChanges;
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<V4ConversationFileChangesResult | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preview, setPreview] = useState<V4ConversationFileRewindPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filesChangedLabel = intl.formatMessage(
    {
      id:
        summary?.files === 1
          ? "chat.changeSummary.filesChanged.one"
          : "chat.changeSummary.filesChanged.other",
    },
    { count: String(summary?.files ?? 0) },
  );
  const isReverted = summary?.state === "reverted";
  const canUndo =
    Boolean(context.applyFileRewind && context.previewFileRewind) &&
    header.actions?.canRewindFiles === true &&
    !isReverted;
  const items = details?.items ?? [];
  const target = useMemo<ConversationRowTarget | null>(
    () => (header.entityId ? { rowId: header.rowId, entityId: header.entityId } : null),
    [header.entityId, header.rowId],
  );
  const cachePolicy: ConversationFileChangesRequestOptions["cachePolicy"] =
    header.state === "running" ? "in-flight" : "terminal";
  const fileChangesState = summary?.state;

  useEffect(() => {
    if (!open || !context.fetchFileChanges || !target) return;

    let disposed = false;
    // 运行中的 fileChanges 是某个 projection revision 的局部结果；turn
    // 进入终态后必须废弃局部 details，并用可持久缓存的终态策略重新读取。
    setDetails(null);
    setLoadingDetails(true);
    void context
      .fetchFileChanges(target, {
        cachePolicy,
        fileChangesState,
      })
      .then(
        (result) => {
          if (disposed) return;
          setDetails(result);
          setLoadingDetails(false);
        },
        (loadError: unknown) => {
          if (disposed) return;
          logger.warn("[ConversationFileSummaryPanel] 读取文件变更详情失败", {
            error: loadError instanceof Error ? loadError.message : String(loadError),
            rowId: target.rowId,
          });
          setLoadingDetails(false);
        },
      );

    return () => {
      disposed = true;
    };
  }, [cachePolicy, context.fetchFileChanges, fileChangesState, open, target]);

  const handlePreviewRewind = useCallback(async () => {
    if (!context.previewFileRewind || !target) return;
    setDialogOpen(true);
    setPreviewLoading(true);
    setError(null);
    try {
      setPreview(await context.previewFileRewind(target));
    } catch {
      setError(intl.formatMessage({ id: "chat.changeSummary.rewindDialog.error" }));
    } finally {
      setPreviewLoading(false);
    }
  }, [context, intl, target]);

  const handleApply = useCallback(async () => {
    if (!context.applyFileRewind || !preview?.canApply || !target) return;
    setApplying(true);
    setError(null);
    try {
      const ack: CommandAck = await context.applyFileRewind(target);
      if (ack.status === "accepted" || ack.status === "duplicate") {
        setDialogOpen(false);
      } else {
        setError(
          ack.message ?? intl.formatMessage({ id: "chat.changeSummary.rewindDialog.error" }),
        );
      }
    } catch {
      setError(intl.formatMessage({ id: "chat.changeSummary.rewindDialog.error" }));
    } finally {
      setApplying(false);
    }
  }, [context, intl, preview?.canApply, target]);

  useEffect(() => {
    if (!details || !summary || summary.files <= 0 || details.items.length > 0) {
      return;
    }
    logger.warn("[ConversationFileSummaryPanel] 文件摘要详情为空", {
      expectedFiles: summary.files,
      rowId: header.rowId,
      turnId: header.turnId,
    });
  }, [details, header.rowId, header.turnId, summary]);

  if (!summary || summary.files <= 0) return null;

  return (
    <>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="overflow-hidden rounded-xl border border-border bg-card shadow-none"
      >
        <div className="flex h-10 items-center justify-between gap-3 px-2 transition-colors hover:bg-hover">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left text-ui-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              aria-label={intl.formatMessage({
                id: open ? "chat.changeSummary.collapse" : "chat.changeSummary.expand",
              })}
            >
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-foreground-subtlest transition-transform",
                  open ? "rotate-90" : "rotate-0",
                )}
              />
              <span className="min-w-0 truncate font-medium">{filesChangedLabel}</span>
              <span className="shrink-0 tabular-nums">
                <span className="text-diff-added">+{summary.additions}</span>{" "}
                <span className="text-diff-removed">-{summary.deletions}</span>
              </span>
              {isReverted ? (
                <span className="shrink-0 rounded-sm bg-input px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "chat.changeSummary.reverted" })}
                </span>
              ) : null}
            </button>
          </CollapsibleTrigger>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!canUndo || previewLoading || applying}
            onClick={handlePreviewRewind}
            title={intl.formatMessage({ id: "chat.changeSummary.rewind" })}
          >
            {previewLoading || applying ? <Loader2Icon className="animate-spin" /> : <Undo2Icon />}
            <span>{intl.formatMessage({ id: "chat.changeSummary.rewind" })}</span>
          </Button>
        </div>
        <CollapsibleContent>
          <div className="grid w-full border-t border-border">
            {loadingDetails ? (
              <div className="flex h-8 items-center gap-2 px-2 text-ui-base text-foreground-subtle">
                <Loader2Icon className="size-3.5 animate-spin" />
                {intl.formatMessage({
                  id: "chat.changeSummary.rewindDialog.loading",
                })}
              </div>
            ) : details && items.length === 0 ? (
              <div className="px-2 py-1.5 text-ui-base text-foreground-subtle">
                {intl.formatMessage({
                  id: "chat.changeSummary.diffUnavailable",
                })}
              </div>
            ) : (
              items.map((item) => {
                // 展示/标题用的相对路径：基准取最深包含根（会话执行 cwd 命中优先，
                // 回落工作区身份根）。直接用 `fileSearchRootPath ?? workspacePath` 会让
                // 会话目录之外、仍在对话根下的文件（如 `.zcodium/skills/...`）退化成绝对路径，
                // 所以这里按「谁真正包含它」选根。
                const displayBasePath =
                  resolveFileDisplayBasePath(item.path, [
                    context.fileSearchRootPath,
                    context.workspacePath,
                  ]) ?? context.workspacePath;
                // `toWorkspaceRelativePath` 名字里的 workspace 是历史命名，这里喂的是展示基准根。
                const relativePath = toWorkspaceRelativePath(displayBasePath, item.path);
                const canReview = item.patches.length > 0 && Boolean(context.onOpenCodeViewer);
                // 注意：preview source 的 workspacePath 仍是工作区身份根（code viewer 作用域），
                // 只有 title 用展示相对路径——与 spec 已知边界 4「预览面包屑按工作区键路径」的
                // 例外只落在这一处标题上，diff 本身的 scope 不变。
                const filePreviewSource = buildChangeSummaryFilePreviewSource({
                  // 读取/打开用模型 cwd 解析后的路径；标题仍是展示相对路径。
                  path: readSummaryFilePath(item.path, context),
                  relativePath,
                  workspacePath: context.workspacePath,
                  workspaceIdentity: context.workspaceIdentity,
                  workspaceRemoteSessionId: context.workspaceRemoteSessionId,
                });
                return (
                  <div key={item.path} className="w-full bg-background/50 overflow-hidden">
                    <div
                      aria-disabled={!canReview}
                      className={cn(
                        "flex w-full items-center gap-1 px-2 py-2 text-left transition-colors",
                        canReview ? "cursor-pointer hover:bg-hover/30" : "cursor-default",
                      )}
                      onClick={() => openDiff(item, context)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        openDiff(item, context);
                      }}
                      role="button"
                      tabIndex={canReview ? 0 : -1}
                      title={item.path}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <div className="min-w-0 flex items-center">
                          <FileDisplayInline
                            path={item.path}
                            options={{
                              basePath: displayBasePath,
                              showFilePath: true,
                              className: "inline-flex min-w-0 max-w-full items-center gap-1.5",
                              fileNameClassName:
                                "truncate text-ui-base font-medium text-foreground",
                              filePathClassName: "truncate text-ui-base text-foreground-subtlest",
                            }}
                          />
                        </div>
                        {/* writeCount 是撤销预检使用的操作轨迹，摘要行已经用 +/- 表达最终结果；
                            在这里展示会把内部操作次数误当成变更指标，因此只在撤销弹窗保留。 */}
                        <span className="flex shrink-0 items-center gap-2 tabular-nums text-ui-base">
                          {item.additions > 0 ? (
                            <span className="text-diff-added">+{item.additions}</span>
                          ) : null}
                          {item.deletions > 0 ? (
                            <span className="text-diff-removed">-{item.deletions}</span>
                          ) : null}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="default"
                          aria-label={intl.formatMessage({
                            id: "chat.changeSummary.review",
                          })}
                          title={intl.formatMessage({
                            id: "chat.changeSummary.review",
                          })}
                          disabled={!canReview}
                          className="h-7 gap-1.5 rounded-lg bg-input px-2 text-ui-base"
                          onClick={(event) => {
                            event.stopPropagation();
                            openDiff(item, context);
                          }}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <span>
                            {intl.formatMessage({
                              id: "chat.changeSummary.review",
                            })}
                          </span>
                        </Button>
                        <OpenSplitButton
                          target={{
                            type: "file",
                            path: readSummaryFilePath(item.path, context),
                            title: relativePath,
                            label: relativePath,
                            previewSource: filePreviewSource,
                          }}
                          onOpenCodeViewer={context.onOpenCodeViewer}
                          stopPropagation
                        />
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <ConversationFileRewindDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        preview={preview}
        previewLoading={previewLoading}
        applying={applying}
        error={error}
        onApply={handleApply}
      />
    </>
  );
}
