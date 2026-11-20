import { useEffect, useMemo, useState } from "react";
import type { EditorInfo, ManagedWorktreeError } from "@zcode/shared";
import type {
  IManagedWorktreeService,
  ManagedWorktreeEntry,
  ManagedWorktreeTask,
  ProjectSidebarProps,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { useManagedWorktreeList } from "@/project-sidebar/useManagedWorktrees.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { readLastSelectedEditorId } from "@/lib/editorPreference.js";
import { isFileManagerOpenTarget, sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { logger } from "@/logger.js";
import { type RowError, worktreeName, WorktreeRow } from "./ManagedWorktreeRow.js";

type ZCodeIntl = ReturnType<typeof useZCodeIntl>["intl"];

/** 只按结构化 code（及 in-use 的 detail）选择文案，不解析 git 原始报错。 */
function describeRemoveError(intl: ZCodeIntl, error: ManagedWorktreeError): RowError {
  const msg = (id: string) => intl.formatMessage({ id: `git.managedWorktree.dialog.${id}` });
  if (error.code === "worktree-dirty") return { message: msg("error.dirty") };
  if (error.code === "worktree-in-use" && error.detail === "running")
    return { message: msg("error.running") };
  if (error.code === "worktree-in-use" && error.detail === "terminal")
    return { message: msg("error.terminal") };
  if (error.code === "worktree-in-use" && error.detail === "creating")
    return { message: msg("error.creating") };
  if (error.code === "worktree-in-use" && error.detail === "tasks")
    return { message: msg("error.tasks") };
  if (error.code === "worktree-in-use" && error.detail === "removing")
    return { message: msg("error.removing") };
  if (error.code === "session-close-failed") return { message: msg("error.sessionClose") };
  return { message: msg("error.generic"), detail: error.detail || error.code };
}

/** 外部编辑器沿用顶部编辑器按钮持久化的偏好；文件管理器单独成项，不作为编辑器候选。 */
function usePreferredEditor(): EditorInfo | null {
  const platform = usePlatform();
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  useEffect(() => {
    let disposed = false;
    platform
      .getInstalledEditors()
      .then((installed) => {
        if (!disposed) setEditors(installed);
      })
      .catch((error: unknown) => {
        logger.warn("[managed-worktree] 获取已安装编辑器失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
    };
  }, [platform]);
  return useMemo(() => {
    const candidates = sortInstalledEditorsForOpenWith(editors).filter(
      (editor) => !isFileManagerOpenTarget(editor),
    );
    const preferredId = readLastSelectedEditorId();
    return candidates.find((editor) => editor.id === preferredId) ?? candidates[0] ?? null;
  }, [editors]);
}

export function ManagedWorktreesDialog({
  project,
  service,
  onClose,
  onOpenTask,
}: {
  project: VirtualProject;
  service: IManagedWorktreeService;
  onClose(): void;
  onOpenTask: ProjectSidebarProps["onSelectTask"];
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `git.managedWorktree.dialog.${id}` }, values);
  const { groups, loading, error, reload } = useManagedWorktreeList(service, project.id);
  const editor = usePreferredEditor();
  const [confirming, setConfirming] = useState<ManagedWorktreeEntry | null>(null);
  const [removing, setRemoving] = useState(false);
  const [pruningRoot, setPruningRoot] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({});
  const busy = removing || pruningRoot !== null;
  const visibleGroups = (groups ?? []).filter((group) => group.worktrees.length > 0);

  const setRowError = (path: string, value: RowError | null) =>
    setRowErrors((previous) => {
      const next = { ...previous };
      if (value) next[path] = value;
      else delete next[path];
      return next;
    });

  const openTask = (task: ManagedWorktreeTask) => {
    void onOpenTask(task.workspacePath, task.taskId, task.workspaceIdentity);
    onClose();
  };

  const confirmRemove = async () => {
    const target = confirming;
    if (!target || removing) return;
    setRemoving(true);
    setRowError(target.path, null);
    try {
      // 只有没有任务使用的残留 worktree 才允许丢弃改动（§3.11）；Host 会再次校验。
      const force = target.dirty === true && target.tasks.length === 0;
      const result = await service.removeWorktree({
        projectId: project.id,
        path: target.path,
        ...(force ? { force: true } : {}),
      });
      if (result.ok) {
        logger.info("[managed-worktree] 已删除 worktree", { path: target.path });
        await reload();
      } else {
        logger.warn("[managed-worktree] 删除 worktree 被拒绝", {
          path: target.path,
          code: result.error.code,
          detail: result.error.detail,
        });
        setRowError(target.path, describeRemoveError(intl, result.error));
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      logger.warn("[managed-worktree] 删除 worktree 失败", { path: target.path, error: detail });
      setRowError(target.path, { message: msg("error.generic"), detail });
    } finally {
      setRemoving(false);
      setConfirming(null);
    }
  };

  const prune = async (worktree: ManagedWorktreeEntry) => {
    if (busy) return;
    setPruningRoot(worktree.sourceRoot);
    setRowError(worktree.path, null);
    try {
      await service.pruneWorktrees({ projectId: project.id, sourceRoot: worktree.sourceRoot });
      logger.info("[managed-worktree] 已清理缺失 worktree 记录", {
        sourceRoot: worktree.sourceRoot,
      });
      await reload();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      logger.warn("[managed-worktree] 清理 worktree 记录失败", {
        sourceRoot: worktree.sourceRoot,
        error: detail,
      });
      setRowError(worktree.path, { message: msg("pruneFailed"), detail });
    } finally {
      setPruningRoot(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="managed-worktrees-dialog"
        className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl"
      >
        <DialogHeader className="pr-8">
          <DialogTitle>{msg("title")}</DialogTitle>
          <DialogDescription className="break-words">
            {msg("description", { project: project.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {error ? (
            <div
              role="alert"
              data-testid="managed-worktrees-error"
              className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 sm:flex-row sm:items-start"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-ui-base text-destructive">{msg("loadFailed")}</span>
                <span className="break-all font-mono text-ui-sm text-foreground-subtle">
                  {error}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 self-start rounded-lg"
                disabled={loading}
                onClick={() => void reload()}
              >
                {intl.formatMessage({ id: "common.retry" })}
              </Button>
            </div>
          ) : null}
          {groups === null && loading ? (
            <div className="flex items-center gap-2 py-6 text-ui-base text-foreground-subtle">
              <Spinner />
              {intl.formatMessage({ id: "common.loading" })}
            </div>
          ) : null}
          {groups !== null && visibleGroups.length === 0 ? (
            <p
              data-testid="managed-worktrees-empty"
              className="py-6 text-center text-ui-base text-foreground-subtle"
            >
              {msg("empty")}
            </p>
          ) : null}
          {visibleGroups.map((group) => (
            <section
              key={group.sourceRoot}
              data-testid="managed-worktree-group"
              className="flex min-w-0 flex-col gap-1.5"
            >
              <h3 className="break-all font-mono text-ui-sm font-normal text-foreground-subtle">
                {group.sourceRoot}
              </h3>
              <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
                {group.worktrees.map((worktree) => (
                  <WorktreeRow
                    key={worktree.path}
                    worktree={worktree}
                    error={rowErrors[worktree.path]}
                    editor={editor}
                    pruning={pruningRoot === worktree.sourceRoot}
                    busy={busy}
                    onOpenTask={openTask}
                    onDelete={() => setConfirming(worktree)}
                    onPrune={() => void prune(worktree)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
      <AlertDialog
        open={Boolean(confirming)}
        onOpenChange={(open) => {
          // 删除进行中不允许关闭确认框，避免结果回写到已离开的上下文。
          if (!open && !removing) setConfirming(null);
        }}
      >
        <AlertDialogContent data-testid="managed-worktree-delete-confirm">
          {confirming ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="break-words">
                  {msg("confirm.title", { name: worktreeName(confirming) })}
                </AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>{msg("confirm.directory")}</li>
                    <li>{msg("confirm.ignored")}</li>
                    {confirming.dirty && confirming.tasks.length === 0 ? (
                      <li className="text-destructive">{msg("confirm.discardChanges")}</li>
                    ) : null}
                    <li>{msg("confirm.tasks")}</li>
                  </ul>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <p className="break-all font-mono text-ui-sm text-foreground-subtle">
                {confirming.path}
              </p>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={removing}>
                  {intl.formatMessage({ id: "common.cancel" })}
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  data-testid="managed-worktree-delete-confirm-action"
                  disabled={removing}
                  onClick={(event) => {
                    // Action 默认点击即关闭；需要等删除结果，由 confirmRemove 结束后关闭。
                    event.preventDefault();
                    void confirmRemove();
                  }}
                >
                  {removing ? <Spinner className="size-3.5" /> : null}
                  {intl.formatMessage({ id: "common.delete" })}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
