import type { IProjectService, IZCodeTaskService, IServiceAccessor } from "@zcode/services";
import type { BotProjectConnection } from "@zcode/services/bot-project-runtime";
import {
  buildRemoteHostWorkspaceIdentity,
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type SourceServerDirectorySnapshot,
} from "@zcode/shared";

type Workspace = { workspacePath: string; workspaceIdentity: string };
export interface BotSourceScope {
  owner: object;
  services: Pick<
    IServiceAccessor,
    "zcodeTaskService" | "zcodeAgentService" | "modelSelectionService"
  >;
  projectService?: IProjectService;
  inspectWorkspace(target: Workspace): Promise<void>;
}

/** 只适配现有物理连接；不创建 logical tab、Agent 或另一份 workspace 状态。 */
export function createBotProjectBridge(options: {
  resolveSource(sourceServerId: string): BotSourceScope | undefined;
  readDirectory(): Promise<Pick<SourceServerDirectorySnapshot, "profiles" | "servers">>;
  routeTaskService(service: IZCodeTaskService): IZCodeTaskService;
}) {
  const assertCurrent = (serverId: string, source: BotSourceScope) => {
    if (options.resolveSource(serverId)?.owner !== source.owner)
      throw new Error("Bot Source generation is retired");
  };
  async function inspect(serverId: string, source: BotSourceScope, target: Workspace) {
    assertCurrent(serverId, source);
    await source.inspectWorkspace(target);
    // 只读检查也跨 await；旧 owner 返回不能接纳新连接上的任务。
    assertCurrent(serverId, source);
  }
  return {
    resolveConnection(hostId: string): BotProjectConnection | undefined {
      let parsed;
      try {
        parsed = parseRemoteWorkspaceIdentity(buildRemoteHostWorkspaceIdentity(hostId, "/"));
      } catch {
        return undefined;
      }
      const serverId = parsed?.sourceServerId;
      const source = serverId ? options.resolveSource(serverId) : undefined;
      if (!serverId || !source) return undefined;
      return {
        owner: source.owner,
        taskService: options.routeTaskService(source.services.zcodeTaskService),
        modelSelectionService: source.services.modelSelectionService,
        agentService: source.services.zcodeAgentService,
        async bindWorkspace(target) {
          if (
            target.workspaceIdentity !==
            buildServerRemoteWorkspaceIdentity({ serverId, workspacePath: target.workspacePath })
          )
            throw new Error("Bot Source identity/path mismatch");
          await inspect(serverId, source, target);
        },
      };
    },
    async resolveWorkspace(target: Workspace): Promise<Workspace | null> {
      const parsed = parseRemoteWorkspaceIdentity(target.workspaceIdentity);
      if (!parsed || parsed.workspacePath !== target.workspacePath) return null;
      let serverId = parsed.sourceServerId;
      if (!serverId) {
        const before = await options.readDirectory();
        const candidates = before.profiles.filter(
          (profile) =>
            profile.sourceServerId &&
            before.servers.some((server) => server.sourceServerId === profile.sourceServerId) &&
            buildRemoteWorkspaceIdentity(target.workspacePath, profile.target) ===
              target.workspaceIdentity,
        );
        const ids = new Set(candidates.map((profile) => profile.sourceServerId));
        // 同 cwd 不证明同一 Source；完整 alias 歧义必须保留未授权状态。
        if (ids.size !== 1) return null;
        serverId = candidates[0]!.sourceServerId;
        const source = serverId ? options.resolveSource(serverId) : undefined;
        if (!serverId || !source) return null;
        const stable = {
          workspacePath: target.workspacePath,
          workspaceIdentity: buildServerRemoteWorkspaceIdentity({
            serverId,
            workspacePath: target.workspacePath,
          }),
        };
        await inspect(serverId, source, stable);
        const after = await options.readDirectory();
        if (
          !candidates.some((profile) =>
            after.profiles.some(
              (current) =>
                current.profileId === profile.profileId &&
                current.generation === profile.generation &&
                current.sourceServerId === serverId,
            ),
          )
        )
          throw new Error("Bot Source Profile is retired");
        assertCurrent(serverId, source);
        return stable;
      }
      const source = options.resolveSource(serverId);
      if (!source) return null;
      await inspect(serverId, source, target);
      return target;
    },
  };
}
