import type {
  ProjectTask,
  VirtualProject,
  ProjectSidebarProps,
  ProjectAvailability,
  ProjectRowAction,
  RemoteProjectHost,
} from "@/project-sidebar/contract.js";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu.js";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";

export type ProjectNodeProps = {
  project: VirtualProject;
  remoteHost?: RemoteProjectHost;
  deviceLabel?: string;
  hideDeviceName?: boolean;
  diagnostics?: { error?: string };
  expanded: boolean;
  onExpandedChange(value: boolean): void;
  tasks: ProjectTask[];
  hasUnread?: boolean;
  additionalActions?: ProjectRowAction[];
  onCreate(): void;
  onViewFiles?(rootPath: string): void;
  onEdit(): void;
  onDelete(): void;
  onPin(): void;
  onMove(task: { workspacePath: string; workspaceIdentity?: string; taskId: string }): void;
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  availability?: ProjectAvailability;
  onRemoveEntry?(): void;
  /** 仅桌面端远程项目提供：从菜单或待处理详情跳到“设置 › 远程设备”。 */
  onOpenDeviceSettings?(): void;
  /** 仅桌面端提供：跳到“设置 › 项目”批量管理。 */
  onManageProjects?(): void;
};

export function ProjectMenuItems({
  actions,
  context = false,
}: {
  actions: ProjectRowAction[];
  context?: boolean;
}) {
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  return actions.map((action, index) => [
    action.separatorBefore && index > 0 ? <Separator key={`${action.id}-separator`} /> : null,
    <Item
      key={action.id}
      disabled={action.disabled}
      data-testid={`virtual-project-${context && (action.id.startsWith("files-") || action.id === "create-task") ? "context-" : ""}${action.id}`}
      className={action.destructive ? "text-destructive" : undefined}
      onSelect={action.run}
    >
      {action.icon ? <action.icon className="size-4 shrink-0" aria-hidden="true" /> : null}
      {action.label}
    </Item>,
  ]);
}
