import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type {
  IProjectService,
  IRemoteProjectService,
  ProjectAvailability,
  ProjectSidebarProps,
  ProjectTree,
  RemoteProjectDirectory,
  RemoteProjectHost,
  VirtualProject,
} from "@/project-sidebar/contract.js";

/** ProjectComposerMenu 的纯展示投影：父组件保留全部状态与 hooks，仅把 return 的展示 JSX 搬到展示组件。 */
export interface ProjectComposerMenuDisplayProps {
  activeTaskId: string | null | undefined;
  addDevice: () => void;
  allProjects: ProjectTree["projects"];
  allowConversationWorkspaceSelection: boolean;
  availability: ReadonlyMap<string, ProjectAvailability>;
  cancelSelection: () => void;
  canDetachProject: boolean;
  canEditProject: boolean | undefined;
  canUseRemoteWorkspace: boolean;
  chat: { key: string };
  children?: ReactNode;
  compactForRemoteControl: boolean;
  containerClassName?: string;
  createProjectTask: ProjectSidebarProps["onCreateTask"];
  creating: boolean;
  currentDevice: { sourceServerId: string; host?: RemoteProjectHost; isCurrent(): boolean } | null;
  currentProject: VirtualProject | undefined;
  currentWorkspaceIconClassName: string;
  currentWorkspaceTitle: string;
  deviceNames: ReadonlyMap<string, string>;
  directory: RemoteProjectDirectory;
  editingChat: { key: string } | null;
  error: string | null;
  hostId: string | null;
  intl: IntlInstance;
  isConversationWorkspace: boolean;
  onOpenRemoteWorkspace?: ProjectSidebarProps["onOpenRemoteWorkspace"];
  onSelectConversationWorkspace: () => void | Promise<void>;
  refresh: () => Promise<void>;
  remoteService: IRemoteProjectService | undefined;
  restoredChat: { key: string } | null;
  service: IProjectService | undefined;
  setCreating: Dispatch<SetStateAction<boolean>>;
  setEditingChat: Dispatch<SetStateAction<{ key: string } | null>>;
  setWorkspaceSearchQuery: Dispatch<SetStateAction<string>>;
  trigger: RefObject<HTMLButtonElement | null>;
  triggerClassName?: string;
  triggerIndicator?: ReactNode;
  visibleProjects: VirtualProject[];
  workspaceIdentity?: string;
  workspacePath: string;
  workspaceSearchQuery: string;
}
