import {
  FileDisplayIcon,
  getFileDisplayPath,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import { FlipMetricValue } from "@/components/ui/flip-metric-value.js";
import { getPathLeaf } from "@/lib/path.js";
import { inferEditOperation } from "@/ToolCallBlocks/fileSummaries.js";
import type {
  EditKindSource,
  EditKindLabelId,
  EditOperationKind,
  RawToolCallFileSummary,
} from "@/ToolCallBlocks/fileSummaryTypes.js";

export function renderDiffCount(
  changeStat?: {
    added: number;
    removed: number;
  },
  options?: { animateInitial?: boolean },
) {
  if (!changeStat) {
    return null;
  }

  if (changeStat.added <= 0 && changeStat.removed <= 0) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono leading-none tabular-nums">
      {changeStat.added > 0 ? (
        <span
          aria-label={`+${changeStat.added}`}
          className="inline-flex items-center text-diff-added"
          role="text"
          title={`+${changeStat.added}`}
        >
          +{/* 性能修复：投影已按秒给出真实统计，数字只做一次短翻页，不再逐行 rAF 追赶。 */}
          <FlipMetricValue
            value={String(changeStat.added)}
            animateInitial={options?.animateInitial}
          />
        </span>
      ) : null}
      {changeStat.removed > 0 ? (
        <span
          aria-label={`-${changeStat.removed}`}
          className="inline-flex items-center text-diff-removed"
          role="text"
          title={`-${changeStat.removed}`}
        >
          -
          <FlipMetricValue
            value={String(changeStat.removed)}
            animateInitial={options?.animateInitial}
          />
        </span>
      ) : null}
    </span>
  );
}

export function renderFileChip({
  summary,
  clickable = false,
  onClick,
  title,
  basePath,
}: {
  summary: RawToolCallFileSummary;
  clickable?: boolean;
  onClick?: () => void;
  title?: string;
  /**
   * 展示基准根：调用方传**最深包含根**（`resolveFileDisplayBasePath(path, [会话执行 cwd, 身份根])`），
   * 不是无脑的身份根——对话会话下身份根会把 `2026-10-11/<id8>/` 留在 chip 提示里。
   */
  basePath?: string;
}) {
  const descriptor = resolveFileDisplayDescriptor(summary.path, {
    basePath,
  });
  const chipTitle = title ?? getFileDisplayPath(summary.path, basePath);

  if (clickable) {
    return (
      <button
        type="button"
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle hover:underline"
        title={chipTitle}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClick?.();
        }}
      >
        <FileDisplayIcon src={descriptor.fileIconSrc} size={16} className="size-4 shrink-0" />
        <span className="min-w-0 truncate text-foreground-subtle">{getPathLeaf(summary.path)}</span>
      </button>
    );
  }

  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle"
      title={chipTitle}
    >
      <FileDisplayIcon src={descriptor.fileIconSrc} size={16} className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{getPathLeaf(summary.path)}</span>
    </span>
  );
}

export function renderFilePath(path: string | null | undefined, basePath?: string) {
  // basePath 同 renderFileChip：调用方传最深包含根（会话执行 cwd 优先，回落身份根）。
  if (!path) {
    return null;
  }

  return (
    <span className="min-w-0 truncate text-foreground-subtlest @max-[360px]/conversation:hidden">
      {/* 窄会话流里父目录会与文件名争抢空间，Read/Edit 最终只剩动作标签和省略号。
          小容器隐藏次要路径，让文件名继续承担主识别信息。 */}
      {getFileDisplayPath(path, basePath)}
    </span>
  );
}

/**
 * 次级路径（父目录）展示。
 *
 * 注意第一参数必须是**绝对文件路径**，不是摘要对象上的 `filePath`：后者是摘要构建期
 * 按 fileDisplay 的模块缺省基准（Root.tsx 注入的 activeWorkspacePath = 工作区身份根）
 * 算好的相对目录串，展示基准换成会话执行 cwd（模型写相对路径的 cwd）后必须按新基准重算，
 * 否则次级路径仍带 `2026-10-11/a1b2c3d4/` 前缀，
 * 见 docs/specs/conversation-session-workspace.md 已知边界 12。
 */
export function renderFileDirectoryPath(path: string | null | undefined, basePath?: string) {
  if (!path) {
    return null;
  }

  return renderFilePath(resolveFileDisplayDescriptor(path, { basePath }).filePath, basePath);
}

export function getEditKindLabelMessageId(
  operationKinds: EditOperationKind[],
  actionLabels: Array<RawToolCallFileSummary["actionLabel"]>,
  isRunning: boolean,
  source?: EditKindSource,
): EditKindLabelId {
  const inferredOperation = inferEditOperation(operationKinds, actionLabels, source);

  if (inferredOperation === "write") {
    return isRunning ? "chat.toolCall.edit.writing" : "chat.toolCall.kind.write";
  }

  if (inferredOperation === "delete") {
    return isRunning ? "chat.toolCall.edit.deleting" : "chat.toolCall.kind.delete";
  }

  if (actionLabels.length === 0) {
    return isRunning ? "chat.toolCall.edit.editing" : "chat.toolCall.kind.edit";
  }

  return isRunning ? "chat.toolCall.edit.editing" : "chat.toolCall.kind.edit";
}

export function renderJoinedFileChips(
  summaries: RawToolCallFileSummary[],
  options: {
    clickable?: boolean;
    onClick?: (summary: RawToolCallFileSummary) => void;
    basePath?: string;
    /**
     * 逐条文件的展示基准根：同一次工具调用的多个文件可能落在不同根下
     * （会话执行目录内与会话执行目录外的绝对路径混在一起），给定时优先于 `basePath`。
     */
    resolveBasePath?: (summary: RawToolCallFileSummary) => string | undefined;
  } = {},
) {
  return (
    <div className="inline-flex min-w-0 items-center">
      {summaries.map((summary, index) => (
        <span key={summary.path} className="inline-flex min-w-0 items-center">
          {index > 0 ? <span className="mx-1 text-foreground-subtlest">,</span> : null}
          {renderFileChip({
            summary,
            clickable: options.clickable,
            basePath: options.resolveBasePath?.(summary) ?? options.basePath,
            onClick: options.onClick ? () => options.onClick?.(summary) : undefined,
          })}
        </span>
      ))}
    </div>
  );
}
