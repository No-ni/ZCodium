import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { RemoteProjectList } from "@/project-sidebar/RemoteProjectList.js";
import { ProjectFolderTrustDialog } from "@/project-sidebar/ProjectFolderTrustDialog.js";
import { ProjectEditorForm } from "@/project-sidebar/ProjectEditorForm.js";
import type { ProjectEditorDialogProps } from "@/project-sidebar/projectEditorTypes.js";

/**
 * 编辑器弹层：只消费 ProjectEditor 给出的值与回调。
 * 草稿、确认请求与保存/删除仍在 ProjectEditor，本组件不持有状态、不调用服务。
 */
export function ProjectEditorDialog({
  suspended,
  folderTrust,
  existing,
  remoteService,
  service,
  onPrepareExisting,
  onSavedExisting,
  browsing,
  directoryServices,
  changeDialogOpen,
  reportLegacyCapability,
  closeExistingList,
  selectDirectory,
  cancelBrowsing,
  restoreTrustFocus,
  form,
}: ProjectEditorDialogProps) {
  const { project, msg, fixedFolder, selectedDevice } = form;
  return (
    <Dialog open={!suspended} onOpenChange={changeDialogOpen}>
      <DialogContent
        className="max-w-lg gap-5"
        onKeyDown={fixedFolder ? (event) => event.stopPropagation() : undefined}
      >
        {existing && selectedDevice && remoteService ? (
          <RemoteProjectList
            key={selectedDevice.id}
            embedded
            device={selectedDevice}
            service={service}
            remoteService={remoteService}
            onBeforeAdd={(isCurrent) => onPrepareExisting!(selectedDevice.id, isCurrent)}
            onLegacyCapability={reportLegacyCapability}
            onSaved={async (isCurrent) => {
              await onSavedExisting(isCurrent);
            }}
            onClose={closeExistingList}
          />
        ) : (
          <>
            <DialogTitle>
              {browsing ? msg("browse") : project ? msg("edit") : msg("create")}
            </DialogTitle>
            <DialogDescription className="sr-only">{msg("description")}</DialogDescription>
            {browsing ? (
              <div
                className="flex h-96 min-h-0 flex-col gap-2"
                data-testid="virtual-project-directory-browser"
              >
                <DirectoryBrowser
                  embedded
                  showSelectionActions
                  selectLabel={msg("browse")}
                  services={directoryServices}
                  onSelect={selectDirectory}
                  onCancel={cancelBrowsing}
                />
              </div>
            ) : (
              <>
                <ProjectEditorForm {...form} />
              </>
            )}
          </>
        )}
        {/* 确认框须留在父弹层的 React 树内；兄弟节点的触摸取消会被延迟判为外部点击，连带关闭草稿。 */}
        {folderTrust && !suspended ? (
          <ProjectFolderTrustDialog request={folderTrust} onClosed={restoreTrustFocus} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
