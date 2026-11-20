import { type ComponentProps, type ReactNode } from "react";
import {
  ChevronDown,
  Copy,
  FolderOpen,
  GitBranch,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import type { EditorInfo } from "@zcode/shared";
import type { ManagedWorktreeEntry, ManagedWorktreeTask } from "@/project-sidebar/contract.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { getFileManagerLabel } from "@/workspace-file-tree/helpers.js";

interface RowError {
  message: string;
  detail?: string;
}

/** 名称格式固定为 `<仓库名> · <bucket>`；仓库名取源仓库目录名，兼容 Windows 分隔符。 */
function worktreeName(worktree: ManagedWorktreeEntry): string {
  return `${getPathLeaf(worktree.sourceRoot)} · ${worktree.bucket}`;
}

/** 图标按钮 + 提示。禁用原因用 aria-disabled 表达，保留键盘焦点，让提示仍可通过键盘读到。 */
function IconAction({
  label,
  disabledReason,
  onClick,
  className,
  children,
  testId,
}: {
  label: string;
  disabledReason?: string;
  onClick(): void;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  const disabled = Boolean(disabledReason);
  return (
    <ControlHintTooltip title={disabledReason ?? label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-disabled={disabled || undefined}
        data-testid={testId}
        className={cn(
          "rounded-lg text-foreground-subtle hover:text-foreground",
          className,
          // 禁用态放在最后，覆盖调用方的 hover 强调色（如删除的 destructive）。
          disabled &&
            "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-foreground-subtle",
        )}
        onClick={() => {
          if (!disabled) onClick();
        }}
      >
        {children}
      </Button>
    </ControlHintTooltip>
  );
}

function TaskActions({
  tasks,
  onOpenTask,
}: {
  tasks: ManagedWorktreeTask[];
  onOpenTask(task: ManagedWorktreeTask): void;
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string) => intl.formatMessage({ id: `git.managedWorktree.dialog.${id}` });
  const buttonProps: ComponentProps<typeof Button> = {
    type: "button",
    variant: "outline",
    size: "sm",
    className: "rounded-lg",
  };
  const [task] = tasks;
  if (!task) return null;
  if (tasks.length === 1) {
    return (
      <ControlHintTooltip title={task.title || msg("untitledTask")}>
        <Button
          {...buttonProps}
          data-testid="managed-worktree-open-task"
          onClick={() => onOpenTask(task)}
        >
          {msg("openTask")}
        </Button>
      </ControlHintTooltip>
    );
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button {...buttonProps} data-testid="managed-worktree-open-task">
          {msg("openTask")}
          <ChevronDown data-icon="inline-end" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-80">
        {tasks.map((item) => (
          <DropdownMenuItem
            key={`${item.workspacePath}:${item.taskId}`}
            data-testid="managed-worktree-task-item"
            onSelect={() => onOpenTask(item)}
          >
            <span className="min-w-0 flex-1 break-words">{item.title || msg("untitledTask")}</span>
            {item.archived ? (
              <span className="shrink-0 text-ui-sm text-foreground-subtlest">
                {msg("archived")}
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorktreeRow({
  worktree,
  error,
  editor,
  pruning,
  busy,
  onOpenTask,
  onDelete,
  onPrune,
}: {
  worktree: ManagedWorktreeEntry;
  error?: RowError;
  editor: EditorInfo | null;
  pruning: boolean;
  busy: boolean;
  onOpenTask(task: ManagedWorktreeTask): void;
  onDelete(): void;
  onPrune(): void;
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `git.managedWorktree.dialog.${id}` }, values);
  const platform = usePlatform();
  const { copyPath, revealInFileManager } = useFileContextActions({
    canOpenLocalFileManager: true,
  });
  const missing = worktree.state === "missing";
  const branch = worktree.branchName
    ? worktree.branchName
    : worktree.head
      ? msg("detached", { sha: worktree.head.slice(0, 7) })
      : null;
  const openInEditor = async () => {
    if (!editor) return;
    const result = await platform.openInEditor(editor.id, worktree.path, {
      pathKind: "directory",
    });
    if (result.success) return;
    logger.warn("[managed-worktree] 在编辑器中打开 worktree 失败", {
      path: worktree.path,
      editor: editor.id,
      error: result.error ?? "unknown-error",
    });
    toast(msg("openInEditorFailed", { editor: editor.name }));
  };
  return (
    <li
      data-testid="managed-worktree-row"
      data-path={worktree.path}
      data-state={worktree.state}
      className="flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-all text-ui-base font-medium text-foreground">
            {worktreeName(worktree)}
          </span>
          {missing ? (
            <Badge className="h-5 rounded-lg bg-tag px-2 text-ui-xs font-medium text-foreground-subtle">
              {msg("missing")}
            </Badge>
          ) : null}
          {worktree.dirty ? (
            <Badge className="h-5 rounded-lg bg-warning-surface px-2 text-ui-xs font-medium text-warning-surface-foreground">
              {msg("dirty")}
            </Badge>
          ) : null}
        </div>
        {branch ? (
          <div className="flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
            <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate font-mono">{branch}</span>
          </div>
        ) : null}
        <ControlHintTooltip title={worktree.path} triggerClassName="min-w-0 max-w-full">
          <span className="block truncate font-mono text-ui-sm text-foreground-subtlest">
            {worktree.path}
          </span>
        </ControlHintTooltip>
        {worktree.tasks.length === 0 ? (
          <span className="text-ui-sm text-foreground-subtlest">{msg("noTasks")}</span>
        ) : null}
        {error ? (
          <p role="alert" className="break-words text-ui-sm text-destructive">
            {error.message}
            {error.detail ? (
              <span className="mt-0.5 block break-all font-mono text-foreground-subtle">
                {error.detail}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <TaskActions tasks={worktree.tasks} onOpenTask={onOpenTask} />
        <IconAction
          label={intl.formatMessage({ id: "appHeader.copyPath" })}
          testId="managed-worktree-copy-path"
          onClick={() => void copyPath({ path: worktree.path, kind: "directory" })}
        >
          <Copy className="size-3.5" />
        </IconAction>
        {missing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-lg"
            data-testid="managed-worktree-prune"
            disabled={busy}
            onClick={onPrune}
          >
            {pruning ? <Spinner className="size-3.5" /> : null}
            {msg("prune")}
          </Button>
        ) : (
          <>
            <IconAction
              label={getFileManagerLabel(intl)}
              testId="managed-worktree-reveal"
              onClick={() => void revealInFileManager({ path: worktree.path, kind: "directory" })}
            >
              <FolderOpen className="size-3.5" />
            </IconAction>
            {editor ? (
              <IconAction
                label={intl.formatMessage(
                  { id: "appHeader.openInEditor" },
                  { editor: editor.name },
                )}
                testId="managed-worktree-open-editor"
                onClick={() => void openInEditor()}
              >
                <SquareArrowOutUpRight className="size-3.5" />
              </IconAction>
            ) : null}
            {/* 创建中的 worktree 由创建记录的"放弃"处理，不显示删除（§3.11）。
                有任务使用且有改动时禁用；没有任务时允许强制删除，确认框写明会丢弃改动。
                删除时 Host 仍会重新检查所有条件。 */}
            {worktree.creating ? null : (
              <IconAction
                label={msg("delete")}
                testId="managed-worktree-delete"
                disabledReason={
                  worktree.dirty && worktree.tasks.length > 0 ? msg("error.dirty") : undefined
                }
                className="hover:text-destructive"
                onClick={onDelete}
              >
                <Trash2 className="size-3.5" />
              </IconAction>
            )}
          </>
        )}
      </div>
    </li>
  );
}
export { type RowError, worktreeName, IconAction, TaskActions, WorktreeRow };
