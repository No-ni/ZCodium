import type { EditorInfo } from "@zcode/shared";
import { CopyIcon, ExternalLinkIcon, PanelRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu.js";
import {
  FileApplicationChoices,
  FileSaveAsMenuItem,
  useFileApplications,
} from "@/file-menu/index.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistLastSelectedEditorId } from "@/lib/editorPreference.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import { logger } from "@/logger.js";
import { OpenSplitButtonDropdownActions } from "./OpenSplitButtonDropdownActions.js";
import { OpenSplitButtonTrigger } from "./OpenSplitButtonTrigger.js";
import type { OpenSplitButtonProps } from "./OpenSplitButton.types.js";

// 组件 props 与公开 target 类型已拆到 OpenSplitButton.types.ts；这里按原入口
// 重新导出，外部从 @/OpenSplitButton.js import type 的路径和符号保持不变。
export type { OpenSplitButtonTarget } from "./OpenSplitButton.types.js";

export function OpenSplitButton({
  target,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  hideOpenWithMenu = false,
  openDefaultOnPrimary = false,
  viewMenuItems,
  stopPropagation = false,
  renderCard,
}: OpenSplitButtonProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();

  const previewSource = target.type === "file" ? target.previewSource : undefined;
  const matchedOpenContext = useWorkspaceOpenInEditorTarget({
    workspacePath: previewSource?.workspacePath,
    workspaceIdentity: previewSource?.workspaceIdentity,
    workspaceRemoteSessionId: previewSource?.workspaceRemoteSessionId,
  });
  const openInEditorRemoteTarget = matchedOpenContext.remoteTarget;
  const isRemoteSource = Boolean(
    previewSource?.workspaceIdentity ||
    previewSource?.workspaceRemoteSessionId ||
    matchedOpenContext.isRemoteWorkspace,
  );
  const fileActions = useFileContextActions({
    canOpenLocalFileManager: Boolean(platform.canOpenLocalFiles),
    isRemoteWorkspace: isRemoteSource,
    remoteTarget: openInEditorRemoteTarget,
    workspaceIdentity: previewSource?.workspaceIdentity,
  });
  const filePath = target.type === "file" ? target.path : target.localPath;
  const workspacePath =
    target.type === "file" ? previewSource?.workspacePath : target.workspacePath;
  const canOpenNative = Boolean(platform.canOpenLocalFiles && !isRemoteSource);
  const fileApplications = useFileApplications(
    target.type === "file"
      ? { path: target.path, pathKind: "file", workspaceIdentity: previewSource?.workspaceIdentity }
      : null,
    isRemoteSource,
  );
  const defaultApplication = fileApplications.defaultApplication;
  const defaultApplicationTitle = intl.formatMessage(
    {
      id: defaultApplication ? "fileActions.openInApplication" : "chat.previewCards.openDefaultApp",
    },
    defaultApplication ? { application: defaultApplication.name } : undefined,
  );
  useEffect(() => {
    if (openDefaultOnPrimary && canOpenNative) void fileApplications.load();
  }, [openDefaultOnPrimary, canOpenNative, fileApplications.load]);
  const editorRequest = useRef(0);
  const primaryEditorLoadStarted = useRef(false);
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [editorsLoaded, setEditorsLoaded] = useState(false);
  const [loadingEditors, setLoadingEditors] = useState(false);
  const sortedEditors: Array<EditorInfo & { isDefault?: boolean }> = useMemo(
    () =>
      !isRemoteSource
        ? fileApplications.apps.map((app) => ({ ...app, iconDataUrl: app.iconDataUrl ?? "" }))
        : isRemoteSource && !openInEditorRemoteTarget
          ? []
          : resolveWorkspaceEditorSelection({
              installedEditors: editors,
              selectedEditorId: null,
              remoteTarget: openInEditorRemoteTarget,
            }).availableEditors,
    [editors, isRemoteSource, openInEditorRemoteTarget, fileApplications.apps],
  );
  const canPreview = openDefaultOnPrimary
    ? Boolean(canOpenNative || sortedEditors.length)
    : target.type === "website"
      ? Boolean(onOpenBrowserUrl)
      : Boolean(onOpenFileLink || onOpenCodeViewer);
  useEffect(() => {
    primaryEditorLoadStarted.current = false;
    setEditors([]);
    setEditorsLoaded(false);
    setLoadingEditors(false);
    // 卡片虚拟行重用时旧目标的异步应用结果不能覆盖新目标。
    editorRequest.current += 1;
    return () => {
      editorRequest.current += 1;
    };
  }, [
    filePath,
    workspacePath,
    previewSource?.workspaceIdentity,
    previewSource?.workspaceRemoteSessionId,
  ]);

  const stopEventPropagation = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
  };

  const loadEditors = useCallback(async () => {
    if (target.type !== "file") return;
    if (!isRemoteSource) {
      await fileApplications.load();
      return;
    }
    if (editorsLoaded || loadingEditors) {
      return;
    }

    const request = ++editorRequest.current;
    setLoadingEditors(true);
    try {
      const result = await platform.getInstalledEditors();
      if (request !== editorRequest.current) return;
      setEditors(result);
      setEditorsLoaded(true);
    } catch (error) {
      if (request !== editorRequest.current) return;
      logger.warn("[OpenSplitButton] 获取第三方打开方式失败", {
        path: target.path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (request === editorRequest.current) setLoadingEditors(false);
    }
  }, [editorsLoaded, loadingEditors, platform, target, isRemoteSource, fileApplications.load]);

  useEffect(() => {
    // 远端主按钮也需要提前获取可用编辑器；不能等用户先打开下拉才解除禁用。
    // 每个来源只自动请求一次，失败后仍可由用户打开菜单重试，避免渲染循环重试。
    if (
      openDefaultOnPrimary &&
      isRemoteSource &&
      openInEditorRemoteTarget &&
      !primaryEditorLoadStarted.current &&
      !editorsLoaded &&
      !loadingEditors
    ) {
      primaryEditorLoadStarted.current = true;
      void loadEditors();
    }
  }, [
    openDefaultOnPrimary,
    isRemoteSource,
    openInEditorRemoteTarget,
    loadEditors,
    editorsLoaded,
    loadingEditors,
  ]);

  const handlePreview = () => {
    if (openDefaultOnPrimary) {
      if (canOpenNative) handleOpenDefault();
      else if (sortedEditors[0]) handleOpenInEditor(sortedEditors[0]);
      return;
    }
    if (target.type === "website") {
      onOpenBrowserUrl?.(target.url);
      return;
    }

    if (onOpenCodeViewer) {
      onOpenCodeViewer(
        target.previewSource ?? {
          type: "file",
          title: target.title,
          path: target.path,
        },
      );
      return;
    }

    onOpenFileLink?.({
      path: target.path,
      label: target.label,
      pathKind: "file",
      workspacePath: target.previewSource?.workspacePath,
      workspaceIdentity: target.previewSource?.workspaceIdentity,
      workspaceRemoteSessionId: target.previewSource?.workspaceRemoteSessionId,
    });
  };

  const handleOpenInEditor = (editor: EditorInfo) => {
    if (target.type !== "file") {
      return;
    }

    if (!isRemoteSource) {
      void fileApplications.open({ ...editor, isDefault: false });
      return;
    }
    persistLastSelectedEditorId(editor.id);
    // 返回失败和 IPC 拒绝都必须有可见反馈，不能只写日志后静默结束。
    void platform
      .openInEditor(editor.id, target.path, {
        pathKind: "file",
        remoteTarget: openInEditorRemoteTarget,
        workspaceIdentity: target.previewSource?.workspaceIdentity,
      })
      .then((result) => {
        if (!result.success) throw new Error(result.error ?? "unknown-error");
      })
      .catch((error: unknown) => {
        logger.warn("[OpenSplitButton] 第三方 App 打开文件失败", {
          editorId: editor.id,
          path: target.path,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "chat.previewCards.openFileFailed" }));
      });
  };

  const handleOpenExternal = () => {
    if (target.type !== "website" || !target.localPath || !platform.openExternalFile) {
      platform.openExternal(target.type === "website" ? target.url : target.path);
      return;
    }

    const localPath = target.localPath;
    const reportFailure = (error: unknown) => {
      logger.warn("[OpenSplitButton] 浏览器打开本地文件失败", {
        path: localPath,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "chat.previewCards.openExternalFailed" }));
    };
    void platform
      .openExternalFile(localPath)
      .then((result) => {
        if (!result.success) reportFailure(result.error ?? "unknown-error");
      })
      .catch(reportFailure);
  };

  const handleOpenDefault = () => {
    void fileApplications.openDefault();
  };

  // 卡片右键和 Open 下拉共用应用查询与保存动作。
  const renderContextActions = () => {
    const Item = ContextMenuItem;
    const Separator = ContextMenuSeparator;
    return (
      <>
        <Item disabled={!canPreview} onSelect={handlePreview}>
          <PanelRightIcon className="size-4" />
          {intl.formatMessage({
            id: "chat.previewCards.previewInSidePane",
          })}
        </Item>
        {target.type === "website" ? (
          <Item onSelect={handleOpenExternal}>
            <ExternalLinkIcon className="size-4" />
            {intl.formatMessage({ id: "common.open" })}
          </Item>
        ) : (
          <>
            {platform.canOpenLocalFiles && (!isRemoteSource || openInEditorRemoteTarget) && (
              <FileApplicationChoices
                variant="context"
                applications={sortedEditors}
                loading={loadingEditors || fileApplications.loading}
                onOpenDefault={
                  canOpenNative && platform.openExternalFile ? handleOpenDefault : undefined
                }
                onSelect={handleOpenInEditor}
              />
            )}
          </>
        )}
        {target.type === "file" && (
          <FileSaveAsMenuItem
            variant="context"
            path={target.path}
            workspacePath={workspacePath}
            workspaceIdentity={previewSource?.workspaceIdentity}
            workspaceRemoteSessionId={previewSource?.workspaceRemoteSessionId}
          />
        )}
        <Separator />
        {target.type === "website" && (
          <Item onSelect={() => void fileActions.copyAbsolutePath({ path: target.url })}>
            <CopyIcon className="size-4" />
            {intl.formatMessage({ id: "chat.previewCards.copyLink" })}
          </Item>
        )}
        {filePath && (
          <>
            {workspacePath && (
              <Item
                onSelect={() =>
                  void fileActions.copyRelativePath({
                    path: filePath,
                    relativePath: getWorkspaceFileRelativePath(workspacePath, filePath),
                  })
                }
              >
                <CopyIcon className="size-4" />
                {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
              </Item>
            )}
            <Item onSelect={() => void fileActions.copyAbsolutePath({ path: filePath })}>
              <CopyIcon className="size-4" />
              {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
            </Item>
          </>
        )}
      </>
    );
  };

  const button = (
    <OpenSplitButtonTrigger
      hideOpenWithMenu={hideOpenWithMenu}
      canPreview={canPreview}
      openDefaultOnPrimary={openDefaultOnPrimary}
      defaultApplication={defaultApplication}
      defaultApplicationTitle={defaultApplicationTitle}
      intl={intl}
      onPrimaryClick={(event) => {
        stopEventPropagation(event);
        handlePreview();
      }}
      onOpenChange={(open) => open && void loadEditors()}
      onStopPropagation={stopEventPropagation}
      viewMenuItems={viewMenuItems}
      dropdownActions={
        <OpenSplitButtonDropdownActions
          target={target}
          sortedEditors={sortedEditors}
          loadingEditors={loadingEditors || fileApplications.loading}
          canOpenWith={Boolean(
            platform.canOpenLocalFiles && (!isRemoteSource || openInEditorRemoteTarget),
          )}
          handleOpenExternal={handleOpenExternal}
          handleOpenInEditor={handleOpenInEditor}
          handleOpenDefault={
            canOpenNative && platform.openExternalFile ? handleOpenDefault : undefined
          }
        />
      }
    />
  );
  if (!renderCard) return button;
  return (
    <ContextMenu
      onOpenChange={(open) =>
        open &&
        platform.canOpenLocalFiles &&
        (!isRemoteSource || openInEditorRemoteTarget) &&
        void loadEditors()
      }
    >
      <ContextMenuTrigger asChild>
        {renderCard(button, { handlePreview, canPreview })}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64 max-w-[calc(100vw-1rem)]">
        {renderContextActions()}
      </ContextMenuContent>
    </ContextMenu>
  );
}
