import { SearchIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import {
  classifyExploreToolCall,
  formatExploreSummary,
  type ExploreBucket,
} from "@/ToolCallBlocks/renderers/exploreSummary.js";
const EXPLORE_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;
import { extractPlanStepsFromToolInput, extractPlanStepsFromToolOutput } from "@zcode/shared";
import { getExecuteSecondaryText } from "@/ToolCallBlocks/renderers/execute.js";
import { buildReadSummary, ReadFileChip } from "@/ToolCallBlocks/renderers/read.js";
import { getWebFetchPrimaryText } from "@/ToolCallBlocks/renderers/web-fetch.js";
import { getSearchPrimaryText } from "@/ToolCallBlocks/renderers/search.js";
import { renderFileDirectoryPath, resolveToolCallFilePath } from "@/ToolCallBlocks/shared.js";
import { resolveFileDisplayBasePath } from "@/lib/fileDisplay.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { useCallback, type ReactNode } from "react";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ZCodePlanStep } from "@zcode/shared";

type IntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

type AgentChildSummary = {
  animationKey: string;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  title?: string;
};

function getChildActionKindLabel(
  intl: IntlLike,
  family: ReturnType<typeof resolveToolCallIdentity>["family"],
) {
  switch (family) {
    case "file-read":
      return intl.formatMessage({ id: "chat.toolCall.read.reading" });
    case "web-fetch":
      return intl.formatMessage({ id: "chat.toolCall.webFetch.fetching" });
    case "search":
      return intl.formatMessage({ id: "chat.toolCall.search.searching" });
    case "shell":
      return intl.formatMessage({ id: "chat.toolCall.execute.running" });
    default:
      return intl.formatMessage({ id: "chat.toolCall.status.running" });
  }
}

function renderChildActionKindPrefix(actionKindLabel: string | null, content: ReactNode) {
  if (!actionKindLabel) {
    return content;
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-foreground-subtle">{actionKindLabel}</span>
      {content}
    </span>
  );
}

function readTodoPlanFromToolCall(
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ZCodePlanStep[] | null {
  return (
    extractPlanStepsFromToolOutput({
      title: childToolCall.title,
      kind: childToolCall.kind,
      output: childToolCall.output,
    }) ??
    extractPlanStepsFromToolInput({
      title: childToolCall.title,
      kind: childToolCall.kind,
      input: childToolCall.input,
    })
  );
}

function getTodoChildSummary(
  intl: IntlLike,
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): AgentChildSummary | null {
  const plan = readTodoPlanFromToolCall(childToolCall);
  if (!plan || plan.length === 0) {
    return {
      animationKey: `todo:${childToolCall.toolId}:empty`,
      primaryText: (
        <span className="min-w-0 truncate">
          {intl.formatMessage({ id: "chat.toolCall.todo.updating" })}
        </span>
      ),
      title: childToolCall.title,
    };
  }

  const completedCount = plan.filter((step) => step.status === "completed").length;
  const activeStep =
    plan.find((step) => step.status === "in_progress") ??
    plan.find((step) => step.status !== "completed") ??
    plan.at(-1);
  const isComplete = completedCount === plan.length;
  const actionLabel = intl.formatMessage({
    id: isComplete ? "chat.toolCall.todo.updated" : "chat.toolCall.todo.updating",
  });
  const progressText = `${completedCount}/${plan.length}`;
  const primaryText = (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="shrink-0">{progressText}</span>
      {activeStep?.title ? <span className="min-w-0 truncate">{activeStep.title}</span> : null}
    </span>
  );

  return {
    animationKey: `todo:${childToolCall.toolId}:${completedCount}:${plan.length}:${activeStep?.id ?? "none"}:${activeStep?.title ?? ""}`,
    primaryText: (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-foreground-subtle">{actionLabel}</span>
        <span className="min-w-0 truncate">{primaryText}</span>
      </span>
    ),
    title: activeStep?.title ?? childToolCall.title,
  };
}

function getLatestAgentChildSummary(
  intl: IntlLike,
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  context: ToolCallBlockRenderContext,
  options: { includeChildActionKindLabel?: boolean } = {},
): AgentChildSummary | null {
  const childIdentity = resolveToolCallIdentity(childToolCall);
  const actionKindLabel =
    options.includeChildActionKindLabel === true
      ? getChildActionKindLabel(intl, childIdentity.family)
      : null;

  if (childIdentity.family === "todo") {
    return getTodoChildSummary(intl, childToolCall);
  }

  if (childIdentity.family === "file-read") {
    const readSummary = buildReadSummary(childToolCall);
    if (!readSummary) {
      return null;
    }
    const canOpenPreview = readSummary.entryType === "file" && Boolean(context.onOpenCodeViewer);
    const openFilePreview = () => {
      if (readSummary.entryType !== "file") {
        return;
      }

      context.onOpenCodeViewer?.({
        type: "file",
        title: readSummary.fileName,
        // 同 read.tsx：相对路径是模型按自己的 cwd 写的，读它必须按模型 cwd 解析。
        path: resolveToolCallFilePath(
          readSummary.path,
          context.fileReferenceRootPath ?? context.workspacePath,
        ),
      });
    };

    return {
      animationKey: `read:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${readSummary.path}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <ReadFileChip summary={readSummary} clickable={canOpenPreview} onClick={openFilePreview} />,
      ),
      // buildReadSummary 里的 filePath 按模块缺省基准（工作区身份根）算；聚合行展示
      // 基准换成会话执行 cwd 后必须重算，否则父目录串带 `2026-10-11/<id8>/` 前缀。
      secondaryText: renderFileDirectoryPath(
        readSummary.path,
        resolveFileDisplayBasePath(readSummary.path, [
          context.fileReferenceRootPath,
          context.workspacePath,
        ]),
      ),
      title: readSummary.path,
    };
  }

  if (childIdentity.family === "web-fetch") {
    const primaryText = getWebFetchPrimaryText(childToolCall.input);
    return {
      animationKey: `fetch:${childToolCall.toolId}:${primaryText}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <span className="min-w-0 truncate">{primaryText}</span>,
      ),
      title: primaryText,
    };
  }
  if (childIdentity.family === "search") {
    const primaryText = getSearchPrimaryText(intl, childToolCall.input);

    return {
      animationKey: `search:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${primaryText}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <span className="min-w-0 truncate">{primaryText}</span>,
      ),
      title: primaryText,
    };
  }

  if (childIdentity.family === "shell") {
    const secondaryText =
      getExecuteSecondaryText(childToolCall.input) ?? childToolCall.title ?? childToolCall.kind;

    return {
      animationKey: `shell:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${secondaryText}`,
      primaryText: actionKindLabel ? (
        <span className="shrink-0 text-foreground-subtle">{actionKindLabel}</span>
      ) : null,
      secondaryText: <code className="min-w-0 truncate font-sans">{secondaryText}</code>,
      title: typeof secondaryText === "string" ? secondaryText : childToolCall.title,
    };
  }

  const fallbackText =
    childToolCall.title ??
    childToolCall.kind ??
    intl.formatMessage({ id: "chat.toolCall.explore.emptySummary" });

  return {
    animationKey: `tool:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${fallbackText}`,
    primaryText: renderChildActionKindPrefix(
      actionKindLabel,
      <span className="min-w-0 truncate">{fallbackText}</span>,
    ),
    title: typeof fallbackText === "string" ? fallbackText : childToolCall.title,
  };
}

export function getLatestAgentChildSummaryFromChildren(
  intl: IntlLike,
  childToolCalls: readonly TaskChatToolCallTreeNode[],
  context: ToolCallBlockRenderContext,
  options: { includeChildActionKindLabel?: boolean } = {},
) {
  for (let index = childToolCalls.length - 1; index >= 0; index -= 1) {
    const childToolCall = childToolCalls[index]?.toolCall;
    if (!childToolCall) {
      continue;
    }

    const summary = getLatestAgentChildSummary(intl, childToolCall, context, options);
    if (summary) {
      return summary;
    }
  }

  return null;
}

export function ExploreToolCallBlock(context: ToolCallBlockRenderContext) {
  const ToolCallBlock = context.nestedToolRenderer;
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText } = context;
  const { toolCall, childToolCalls } = toolCallNode;
  const counts = childToolCalls.reduce<Record<ExploreBucket, number>>(
    (acc, childToolCallNode) => {
      const bucket = classifyExploreToolCall({
        kind: childToolCallNode.toolCall.kind,
        title: childToolCallNode.toolCall.title,
        input: childToolCallNode.toolCall.input,
      });
      acc[bucket] += 1;
      return acc;
    },
    { search: 0, fetch: 0, list: 0, file: 0 },
  );
  const summary = formatExploreSummary(intl, counts);
  const kindLabel = intl.formatMessage({ id: "chat.toolCall.explore.label" });
  const collapsedChildSummary = isRunning
    ? getLatestExploreChildSummaryFromChildren(intl, childToolCalls, context, {
        includeChildActionKindLabel: true,
      })
    : null;
  const renderContent = useCallback(
    () =>
      childToolCalls.length > 0 ? (
        <div className="ml-2 space-y-2 border-border border-l pl-3.5 border-border">
          {childToolCalls.map((childToolCallNode) => (
            <ToolCallBlock
              key={childToolCallNode.toolCall.toolId}
              toolCallNode={childToolCallNode}
              workspacePath={context.workspacePath}
              fileReferenceRootPath={context.fileReferenceRootPath}
              showIcon={false}
              onOpenCodeViewer={context.onOpenCodeViewer}
              onOpenFileLink={context.onOpenFileLink}
              onOpenBrowserUrl={context.onOpenBrowserUrl}
              onOpenAutomationsMain={context.onOpenAutomationsMain}
              onLoadFullToolCallFields={context.onLoadFullToolCallFields}
            />
          ))}
        </div>
      ) : null,
    [
      childToolCalls,
      context.onLoadFullToolCallFields,
      context.onOpenAutomationsMain,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.fileReferenceRootPath,
      context.workspacePath,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={EXPLORE_TOOL_ICON}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={kindLabel}
        expandedKindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={collapsedChildSummary ? collapsedChildSummary.primaryText : summary}
        expandedPrimaryText={summary}
        secondaryText={collapsedChildSummary?.secondaryText}
        expandedSecondaryText={null}
        animateSummaryContent
        disableSummaryContentAnimation={context.disableSummaryContentAnimation}
        summaryContentKey={
          collapsedChildSummary?.animationKey ??
          `explore:${toolCall.toolId}:${isRunning ? "running" : "done"}:${summary}`
        }
        statusLabel={statusLabel}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={collapsedChildSummary?.title ?? (isRunning ? summary : toolCall.title)}
        expandedTitle={toolCall.title}
        renderContent={renderContent}
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

// 本仓探索分组继续复用同一子工具摘要实现，保留既有公开入口。
export const getLatestExploreChildSummaryFromChildren = getLatestAgentChildSummaryFromChildren;
