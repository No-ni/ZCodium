import { ChatRemoteFolderSelection } from "@/project-sidebar/ChatRemoteFolderSelection.js";
import { RemoteIdentityHoverCard } from "@/project-sidebar/RemoteIdentityHoverCard.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group.js";
import {
  ChevronDownIcon,
  Cloud,
  FolderPlus,
  MessageCircle,
  Plus,
  SearchIcon,
  X,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import {
  TID_COMPOSER_PROJECT_DETACH,
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORK_OUTSIDE_PROJECT,
  TID_COMPOSER_WORKSPACE_TRIGGER,
} from "@zcode/shared/test-ids";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { ProjectCreation } from "@/project-sidebar/ProjectCreation.js";
import { ProjectFolderIcon } from "@/project-sidebar/ProjectFolderIcon.js";
import { projectKey, projectSourceServerId } from "@/project-sidebar/view.js";
import type { ProjectComposerMenuDisplayProps } from "@/project-sidebar/ProjectComposerMenuDisplay.types.js";

export function ProjectComposerMenuDisplay({
  activeTaskId,
  addDevice,
  allProjects,
  allowConversationWorkspaceSelection,
  availability,
  cancelSelection,
  canDetachProject,
  canEditProject,
  canUseRemoteWorkspace,
  chat,
  children,
  compactForRemoteControl,
  containerClassName,
  createProjectTask,
  creating,
  currentDevice,
  currentProject,
  currentWorkspaceIconClassName,
  currentWorkspaceTitle,
  deviceNames,
  directory,
  editingChat,
  error,
  hostId,
  intl,
  isConversationWorkspace,
  onOpenRemoteWorkspace,
  onSelectConversationWorkspace,
  refresh,
  remoteService,
  restoredChat,
  service,
  setCreating,
  setEditingChat,
  setWorkspaceSearchQuery,
  trigger,
  triggerClassName,
  triggerIndicator,
  visibleProjects,
  workspaceIdentity,
  workspacePath,
  workspaceSearchQuery,
}: ProjectComposerMenuDisplayProps) {
  const menu = (
    <DropdownMenu>
      <div
        className={cn(
          "group/workspace-chip relative flex min-w-0 items-center rounded-full hover:bg-surface-hover focus-within:bg-surface-hover",
          containerClassName,
        )}
      >
        {canDetachProject ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="pointer-events-none absolute left-1.5 z-10 rounded-full text-foreground-subtle opacity-0 transition-opacity group-hover/workspace-chip:pointer-events-auto group-hover/workspace-chip:opacity-100 group-focus-within/workspace-chip:pointer-events-auto group-focus-within/workspace-chip:opacity-100"
            aria-label={intl.formatMessage({ id: "chat.empty.detachProject" })}
            data-testid={TID_COMPOSER_PROJECT_DETACH}
            onClick={(event) => {
              event.stopPropagation();
              // 官方 UI 埋点不引入本 fork：解绑直接执行，项目归属仍由 Host 单一所有者回写。
              void Promise.resolve(onSelectConversationWorkspace());
            }}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            className={cn(
              "min-w-0 rounded-full bg-transparent text-ui-base/relaxed hover:bg-transparent",
              // Bugfix: 远程控制页面空态文案区域更窄，workspacePath 过长会把同一行挤坏。
              // 这里在远控模式收紧菜单触发按钮宽度，让超长路径在按钮内走省略号。
              compactForRemoteControl ? "max-w-44 pl-3 pr-2" : "max-w-[15rem] pl-3 pr-2",
              triggerClassName,
            )}
            ref={trigger}
            aria-label={intl.formatMessage({ id: "chat.empty.workspaceMenu" })}
            data-testid={TID_COMPOSER_WORKSPACE_TRIGGER}
          >
            {hostId ? (
              <Cloud className={currentWorkspaceIconClassName} />
            ) : (
              <ProjectFolderIcon
                rootCount={currentProject?.roots.length ?? 0}
                className={currentWorkspaceIconClassName}
              />
            )}
            <span className="block max-w-full truncate">{currentWorkspaceTitle}</span>
            {triggerIndicator ?? <ChevronDownIcon className="size-3.5 text-foreground-subtle" />}
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        data-testid="composer-project-menu"
        align="start"
        side="top"
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <div
          data-slot="command-input-wrapper"
          className="shrink-0 p-1 border-b border-border"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <InputGroup className="h-8 border-0 !bg-transparent hover:border-input-border-hover ">
            <input
              data-slot="command-input"
              value={workspaceSearchQuery}
              placeholder={intl.formatMessage({
                id: "chat.empty.workspaceSearchPlaceholder",
              })}
              onChange={(event) => setWorkspaceSearchQuery(event.target.value)}
              className="w-full text-ui-base/relaxed text-foreground outline-hidden placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50"
            />
            <InputGroupAddon>
              <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="flex min-h-0 flex-col p-1">
          {error ? (
            <div role="alert" className="px-2 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          <div className="min-h-0 max-h-60 overflow-y-auto">
            {visibleProjects.map((project) => {
              const state = availability.get(projectKey(project));
              const isRemoteWorkspace =
                Boolean(state?.entryId) || Boolean(hostId && hostId === project.hostId);
              const disabled = state?.online === false;
              const remoteHost = directory.hosts.find((host) => host.id === project.hostId);
              const deviceName =
                deviceNames?.get(projectSourceServerId(project) ?? "") ||
                (remoteHost ? remoteHostLabel(remoteHost) : undefined);
              return (
                <RemoteIdentityHoverCard
                  key={projectKey(project)}
                  host={remoteHost}
                  title={project.name}
                  projectName={project.name}
                  deviceName={deviceName}
                  paths={project.roots.map((root) => root.rootPath)}
                  anchorToMenu
                  contentClassName="z-[60] max-w-(--radix-hover-card-content-available-width)"
                >
                  <span className="block min-w-0">
                    <DropdownMenuCheckboxItem
                      data-project-id={project.id}
                      data-project-host={project.hostId}
                      data-project-name={project.name}
                      checked={currentProject === project}
                      disabled={disabled}
                      onSelect={() => {
                        logger.info("[ProjectComposerMenu] 选择项目", {
                          projectId: project.id,
                          hostId: project.hostId,
                        });
                        // 同侧栏项目新建入口：由 Root/Host 解析主要目录及远程 attachment。
                        createProjectTask({
                          projectId: project.id,
                          ...(compactForRemoteControl ||
                          directory.hosts.some((host) => host.id === project.hostId)
                            ? { hostId: project.hostId }
                            : {}),
                        });
                      }}
                    >
                      {isRemoteWorkspace ? (
                        <Cloud className="size-4 text-foreground-subtle" />
                      ) : (
                        <ProjectFolderIcon
                          rootCount={project.roots.length}
                          className="size-4 text-foreground-subtle"
                        />
                      )}
                      {/* 不同字号按框居中会让设备名基线上浮；文字单独对齐基线，外层图标仍居中。 */}
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        {deviceName ? (
                          <span
                            data-testid="composer-project-device"
                            className="max-w-36 truncate text-ui-sm text-remote-foreground-muted"
                          >
                            {deviceName}
                          </span>
                        ) : null}
                      </span>
                      {disabled ? (
                        <span className="text-ui-xs text-foreground-subtlest">
                          {intl.formatMessage({ id: "project.offline" })}
                        </span>
                      ) : null}
                    </DropdownMenuCheckboxItem>
                  </span>
                </RemoteIdentityHoverCard>
              );
            })}
            {visibleProjects.length === 0 && !error ? (
              <div className="px-2 py-2 text-ui-base text-foreground-subtlest">
                {intl.formatMessage({ id: "chat.empty.workspaceSearchEmpty" })}
              </div>
            ) : null}
          </div>

          <div className="shrink-0">
            <DropdownMenuSeparator />
            {/* 项目创建依赖共享服务，不能受本机原生打开文件夹的能力开关限制。 */}
            <DropdownMenuItem
              data-testid="composer-create-project"
              disabled={!service || !remoteService}
              onSelect={() => setCreating(true)}
            >
              <FolderPlus className="size-4 text-foreground-subtle" />
              <span>{intl.formatMessage({ id: "project.create" })}</span>
            </DropdownMenuItem>
            {canUseRemoteWorkspace ? (
              <DropdownMenuItem
                data-testid={TID_COMPOSER_REMOTE_CONNECTION}
                onSelect={() => {
                  // Bugfix: 打开远程弹窗时必须让 DropdownMenu 执行默认关闭流程。
                  // 阻止默认 select 会让父菜单与 modal 同时保持打开，浮层层级调整后父菜单会覆盖弹窗。
                  logger.info(
                    `[ProjectComposerMenu] open remote dialog from workspace menu workspace=${workspacePath}`,
                  );
                  // 连接流程由 Root 唯一持有；聊天只提供有效性检查与完成结果接缝。
                  addDevice();
                }}
              >
                <Cloud className="size-4 text-foreground-subtle" />
                <span>{intl.formatMessage({ id: "chat.empty.newRemoteConnection" })}</span>
              </DropdownMenuItem>
            ) : null}
            {allowConversationWorkspaceSelection && !hostId ? (
              <DropdownMenuCheckboxItem
                data-testid={TID_COMPOSER_WORK_OUTSIDE_PROJECT}
                checked={isConversationWorkspace}
                onSelect={() => void Promise.resolve(onSelectConversationWorkspace())}
              >
                <MessageCircle className="size-4 text-foreground-subtle" />
                <span>{intl.formatMessage({ id: "chat.empty.workOutsideProject" })}</span>
              </DropdownMenuCheckboxItem>
            ) : null}
          </div>
        </div>
      </DropdownMenuContent>
      {restoredChat === chat ? (
        <span
          role="status"
          data-testid="chat-restored-target"
          className="max-w-full break-words px-2 text-ui-sm text-foreground-subtle"
        >
          {intl.formatMessage(
            { id: "chat.remoteFolder.restored" },
            {
              device: hostId
                ? (deviceNames?.get(
                    currentProject ? (projectSourceServerId(currentProject) ?? "") : "",
                  ) ?? hostId)
                : intl.formatMessage({ id: "project.thisComputer" }),
              project:
                currentProject?.name ?? intl.formatMessage({ id: "chat.empty.workOutsideProject" }),
            },
          )}
        </span>
      ) : null}
      {currentDevice && service && remoteService ? (
        <ChatRemoteFolderSelection
          request={currentDevice}
          service={service}
          remoteService={remoteService}
          onCreateTask={createProjectTask}
          onClose={cancelSelection}
        />
      ) : null}
      {/* 连接成功仍由目录流程交付聊天；普通创建在同一草稿中选中保存后的项目。 */}
      {creating && service && remoteService ? (
        <ProjectCreation
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          onCreateTask={createProjectTask}
          projects={allProjects}
          directory={directory}
          service={service}
          remoteService={remoteService}
          defaultDeviceId={activeTaskId && hostId ? hostId : "local"}
          allowDeviceManagement={canUseRemoteWorkspace}
          onOpenRemoteWorkspace={onOpenRemoteWorkspace}
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      ) : null}
    </DropdownMenu>
  );
  return (
    <>
      {menu}
      {children}
      {canEditProject ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "project.edit" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-foreground-subtle"
            aria-label={intl.formatMessage({ id: "project.edit" })}
            data-testid="composer-edit-project"
            onClick={() => setEditingChat(chat)}
          >
            <Plus className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {/* 项目身份沿用菜单；聊天切换使旧编辑器失效，避免同 cwd 的项目被误编辑。 */}
      {editingChat === chat && canEditProject && currentProject && service ? (
        <ProjectEditor
          key={projectKey(currentProject)}
          project={currentProject}
          host={directory.hosts.find((host) => host.id === currentProject.hostId)}
          projects={allProjects.filter(
            (project) => !availability.get(projectKey(project))?.entryId,
          )}
          service={service}
          onClose={() => setEditingChat(null)}
          onSaved={refresh}
          onDeleted={refresh}
        />
      ) : null}
    </>
  );
}
