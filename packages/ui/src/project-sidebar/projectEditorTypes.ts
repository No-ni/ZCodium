import type { ComponentProps } from "react";
import type {
  IProjectService,
  VirtualProject,
  RemoteProjectHost,
  ProjectDevice,
} from "@/project-sidebar/contract.js";
import type { IRemoteProjectService } from "@/project-sidebar/contract.js";
import type { ProjectFolderTrustRequest } from "@/project-sidebar/ProjectFolderTrustDialog.js";
import type { ProjectEditorForm } from "@/project-sidebar/ProjectEditorForm.js";
import { useProjectDirectoryServices } from "@/project-sidebar/useProjectDirectoryServices.js";

export type ProjectEditorProps = {
  project: VirtualProject | null;
  remoteService?: IRemoteProjectService;
  onSavedExisting?(isCurrent?: () => boolean): Promise<void>;
  onBrowseExisting?(device: ProjectDevice): Promise<boolean>;
  onPrepareExisting?(hostId: string, isCurrent: () => boolean): Promise<RemoteProjectHost>;
  devices?: ProjectDevice[];
  defaultDeviceId?: string;
  suspended?: boolean;
  onBeforeSave?(hostId: string): Promise<void>;
  onConnectDevice?(device: ProjectDevice): Promise<boolean>;
  onAddDevice?(selectDevice: (id: string) => Promise<void>): void;
  host?: RemoteProjectHost;
  initialRoots?: string[];
  /** 聊天已确认的远程目录；表单不能改成另一个 Host 或 root。 */
  fixedFolder?: { hostId: string; path: string; deviceLabel: string };
  isCurrent?(): boolean;
  projects: VirtualProject[];
  service: IProjectService;
  onClose(): void;
  onSaved(project: VirtualProject): Promise<void>;
  onDeleted?(): Promise<void>;
};

export type ProjectEditorDialogProps = {
  suspended?: boolean;
  folderTrust: ProjectFolderTrustRequest | null;
  existing: boolean;
  remoteService?: IRemoteProjectService;
  service: IProjectService;
  onPrepareExisting?(hostId: string, isCurrent: () => boolean): Promise<RemoteProjectHost>;
  /** 父编辑器已应用默认回调，展示边界接收的值始终可调用。 */
  onSavedExisting(isCurrent?: () => boolean): Promise<void>;
  browsing: boolean;
  directoryServices: ReturnType<typeof useProjectDirectoryServices>["services"];
  changeDialogOpen(open: boolean): void;
  reportLegacyCapability(legacy: boolean): void;
  closeExistingList(): void;
  selectDirectory(path: string): void;
  cancelBrowsing(): void;
  restoreTrustFocus(): void;
  form: ComponentProps<typeof ProjectEditorForm>;
};
