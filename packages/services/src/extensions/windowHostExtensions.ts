import { attachWindowExtensionHost } from "./windowExtensionConnection.js";
import { createWindowExtensionInventory } from "./windowExtensionInventory.js";
import { createWindowExtensionFacades } from "./windowExtensionFacades.js";
import type { WindowExtensionState } from "./windowHostExtensionsTypes.js";
import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import {
  grantsCover,
  type ContributionSnapshot,
  type ExtensionDeclaration,
  type ExtensionDeclarations,
  type ExtensionHostStatus,
  type ExtensionLogEntry,
  type ExtensionLogsSnapshot,
  type ExtensionStaticTable,
  type StaticPlugin,
} from "@zcode/shared/extension-host";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createCapabilityHandlers,
  type CapabilityGrantFacts,
} from "#src/extensions/capabilityGateway.js";
import { createContextPump } from "#src/extensions/contextPump.js";
import { createExtensionDraftRelay } from "#src/extensions/draftRelay.js";
import { createEnvState } from "#src/extensions/envState.js";
import { createGenerationPump } from "#src/extensions/generationPump.js";
import { createModelsBackend } from "#src/extensions/modelsBackend.js";
import { createMentionItemsRouter } from "#src/extensions/mentionItems.js";
import { createAuditLog } from "#src/extensions/auditLog.js";
import { createGrantsStore } from "#src/extensions/grantsStore.js";
import { createGrantRequestRelay } from "#src/extensions/grantRequestRelay.js";
import { createNotificationRelay } from "#src/extensions/notificationRelay.js";
import { createPluginProjects } from "#src/extensions/pluginProjects.js";
import { createSessionsBackend } from "#src/extensions/sessionsBackend.js";
import { createSessionReads } from "#src/extensions/sessionReads.js";
import { createSessionControls } from "#src/extensions/sessionControls.js";
import { createSettingsBackend } from "#src/extensions/settingsBackend.js";
import { createExtensionViewRelay } from "#src/extensions/viewRelay.js";
import { createWorkbenchState } from "#src/extensions/workbenchState.js";
import type { ExtensionsContributionsMessage } from "#src/extensions/contract.js";
import {
  type WindowHostExtensionsDeps,
  type WindowHostExtensions,
  type Connection,
} from "./windowHostExtensionsTypes.js";
export {
  type WindowHostExtensionsDeps,
  type WindowHostExtensions,
} from "./windowHostExtensionsTypes.js";

export function createWindowHostExtensions(deps: WindowHostExtensionsDeps): WindowHostExtensions {
  // 只在 Window Host（Node）里创建：Renderer 可达的模块顶层不能调用 createServiceLogger。
  const logger = createServiceLogger("extensions");
  const contributions = new Emitter<ExtensionsContributionsMessage>();
  const hostStatus = new Emitter<ExtensionHostStatus>();
  const logs = new Emitter<ExtensionLogEntry[]>();
  /** 在途的日志快照请求：Main 收到即回，按 requestId 配对；本服务销毁时一起失败，不设超时。 */
  const logRequests = new Map<
    string,
    { resolve(snapshot: ExtensionLogsSnapshot): void; reject(error: Error): void }
  >();
  let status: ExtensionHostStatus = { state: "starting", gen: 0 };
  let snapshot: ContributionSnapshot | null = null;
  let table: ExtensionStaticTable = { rev: 0, plugins: [] };
  /** 由同一次读取生成；还没读完清单时为 null，不向扩展进程推空声明。 */
  let declarations: ExtensionDeclarations | null = null;
  let connection: Connection | null = null;
  /** 重读与推送串行：牵线时的推送排在在途的重读之后，扩展进程总是收到最新一份声明。 */
  let staticChain: Promise<void> = Promise.resolve();
  let disposed = false;
  const workbench = createWorkbenchState();
  const env = createEnvState();
  const contextPump = createContextPump({ agent: deps.agent, workbench, logger });
  const generationPump = createGenerationPump({ agent: deps.agent, workbench, logger });
  const views = createExtensionViewRelay({
    connection: () => (connection ? { gen: connection.gen, host: connection.host } : null),
    staticTable: () => table,
    workbench,
    ...(deps.registerSandbox ? { registerSandbox: deps.registerSandbox } : {}),
    logger,
  });
  const settings = createSettingsBackend({
    reader: deps.userOptionsReader,
    pluginManagement: deps.pluginManagement,
    inventoryWorkspacePath: deps.inventoryWorkspacePath,
    logger,
  });
  const drafts = createExtensionDraftRelay({ logger });
  const provideMentionItems = createMentionItemsRouter({
    staticTable: () => table,
    connection: () => (connection ? { gen: connection.gen, host: connection.host } : null),
    agent: deps.agent,
    logger,
  });
  // 用户授权的唯一 owner（grants.json）与审计日志（§17.7、§17.8）。
  const grants = createGrantsStore({ filePath: join(deps.dataDir, "grants.json"), logger });
  const audit = createAuditLog({ dir: join(deps.dataDir, "audit"), logger });
  const sessions = createSessionsBackend({
    appControl: deps.appControl,
    currentGen: () => connection?.gen ?? null,
    covers: (pluginId, grant) => grants.covers(pluginId, grant),
    audit,
    logger,
  });
  // 会话读连接（§17.5）：列表泵、按会话共享的镜像与 readRows；连接作用域跟扩展进程代际走。
  const reads = createSessionReads({
    agent: deps.agent,
    sessions,
    taskRows: deps.taskRows,
    localSourceServerId: () => deps.appControl?.sourceServerId,
    currentGen: () => connection?.gen ?? null,
    // 交互订阅的范围检查（§17.12）：插件项目里的会话。controls 在下面创建，调用时已就绪。
    controlScope: (pluginId, session) => controls.assertScope(pluginId, session),
    logger,
  });
  /** 网关复查开着的需授权订阅的信号：授权状态变化、静态表重发。 */
  const grantFactsChanged = new Emitter<void>();
  const grantsSubscription = grants.onDidChange(() => grantFactsChanged.fire());
  const models = createModelsBackend({ modelSelection: deps.modelSelection, logger });
  const grantState = (pluginId: string) =>
    grants.snapshot().plugins.find((plugin) => plugin.pluginId === pluginId);
  const grantRequests = createGrantRequestRelay({ state: grantState, logger });
  const notifications = createNotificationRelay({
    staticTable: () => table,
    grantState,
    logger,
  });
  // 插件项目只经现有项目服务读写（§17.4）：名字取静态表，数据目录取扩展声明（H6），都是本服务读的同一份清单。
  const pluginProjects = createPluginProjects({
    projects: deps.projects,
    plugin(pluginId) {
      const entry = table.plugins.find((plugin) => plugin.pluginId === pluginId);
      if (!entry) return null;
      const dataPath = declarations?.plugins.find(
        (plugin) => plugin.pluginId === pluginId,
      )?.dataPath;
      return { name: entry.name, ...(dataPath ? { dataPath } : {}) };
    },
    sourceServerId: () => deps.appControl?.sourceServerId,
    logger,
  });
  // 回答审批、提问与切换权限模式（§17.12）：完全访问 = 清单声明了 sessions.fullAccess 且用户授予了。
  const controls = createSessionControls({
    agent: deps.agent,
    reads,
    sessions,
    pluginProjects,
    fullAccess(pluginId) {
      const declared = grantFacts.declared(pluginId);
      if (!declared || !grantsCover(declared.grants, "sessions.fullAccess")) return "not-declared";
      return grants.covers(pluginId, "sessions.fullAccess") ? "granted" : "not-granted";
    },
    logger,
  });
  const handlers = createCapabilityHandlers({
    workbench,
    env,
    context: contextPump,
    generation: generationPump,
    models,
    views,
    settings,
    sessions,
    pluginProjects,
    reads,
    controls,
    drafts,
    grantRequests,
    notifications,
  });
  // 网关查授权的两份事实：清单声明来自静态表（本服务是 owner），用户授权来自授权记录。
  const grantFacts: CapabilityGrantFacts = {
    declared(pluginId) {
      const extension = table.plugins.find((plugin) => plugin.pluginId === pluginId)?.extension;
      return extension?.state === "ok"
        ? { grants: extension.grants, protocols: extension.protocols }
        : null;
    },
    granted: (pluginId, grant) => grants.covers(pluginId, grant),
    onDidChange: grantFactsChanged.event,
  };

  const detach = (reason: string) => {
    const current = connection;
    if (!current) return;
    connection = null;
    // 视图实例属于这一代扩展进程：一并作废，标签页按新代际重建。
    views.detach();
    // 旧代际的会话调用（wait 最长 300 秒）一并中止：结果已经没有接收方。
    sessions.abortAll();
    // 读连接作用域与镜像属于这一代：一并释放（scope.dispose() 退订全部）。
    reads.detach();
    current.subscription.dispose();
    current.server.dispose();
    current.client.dispose();
    current.protocol.disconnect();
    logger.info(undefined, `extension host detached gen=${current.gen} (${reason})`);
    if (snapshot) {
      snapshot = null;
      contributions.fire({ kind: "detached" });
    }
  };

  /** 排进串行链；返回这一步的结果（失败照常记一条 warn，链不中断）。 */
  const enqueueStatic = (label: string, task: () => Promise<void>): Promise<void> => {
    const run = staticChain.then(task);
    staticChain = run.catch((error: unknown) => {
      logger.warn(undefined, `${label} failed`, {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return run;
  };

  /** 最近一次读到的清单：激活确认的决定改变后，不重读插件清单就能重新发布（§17.7）。 */
  let resolvedPlugins: Array<{ entry: StaticPlugin; declaration: ExtensionDeclaration | null }> =
    [];
  const state: WindowExtensionState = {
    get status() {
      return status;
    },
    set status(value) {
      status = value;
    },
    get snapshot() {
      return snapshot;
    },
    set snapshot(value) {
      snapshot = value;
    },
    get table() {
      return table;
    },
    set table(value) {
      table = value;
    },
    get declarations() {
      return declarations;
    },
    set declarations(value) {
      declarations = value;
    },
    get connection() {
      return connection;
    },
    set connection(value) {
      connection = value;
    },
    get disposed() {
      return disposed;
    },
    set disposed(value) {
      disposed = value;
    },
    get resolvedPlugins() {
      return resolvedPlugins;
    },
    set resolvedPlugins(value) {
      resolvedPlugins = value;
    },
  };
  const { publishStatic, pushDeclarations, refreshStatic } = createWindowExtensionInventory({
    state,
    deps,
    grants,
    sessions,
    logger,
    contributions,
    grantFactsChanged,
    enqueueStatic,
  });
  const { service, grantsService, viewsService, revokeGrants } = createWindowExtensionFacades({
    state,
    deps,
    grants,
    audit,
    sessions,
    logger,
    contributions,
    hostStatus,
    logs,
    logRequests,
    provideMentionItems,
    workbench,
    env,
    grantRequests,
    views,
    drafts,
    notifications,
    enqueueStatic,
    publishStatic,
    pushDeclarations,
    refreshStatic,
  });

  return {
    service,
    viewsService,
    grantsService,
    announceReady() {
      refreshStatic("startup");
      deps.postToMain({ type: "extension-host/window-ready" });
    },
    receiveControl(message, port) {
      if (disposed) return;
      if (message.type === "extension-host/logs") {
        logs.fire(message.entries);
        return;
      }
      if (message.type === "extension-host/logs-snapshot") {
        const request = logRequests.get(message.requestId);
        if (!request) return;
        logRequests.delete(message.requestId);
        request.resolve({ entries: message.entries, lastSeq: message.lastSeq });
        return;
      }
      if (message.type === "extension-host/status") {
        status = message.status;
        // 扩展进程不在运行：旧代际的连接与快照作废。
        if (message.status.state !== "running") detach(`status ${message.status.state}`);
        hostStatus.fire(status);
        return;
      }
      if (!port) {
        logger.warn(undefined, `extension host pair message without a port gen=${message.gen}`);
        return;
      }
      attachWindowExtensionHost(message.gen, port.port, port.onClose, {
        state,
        detach,
        handlers,
        grantFacts,
        logger,
        contributions,
        views,
        enqueueStatic,
        pushDeclarations,
      });
    },
    refreshInventory(change) {
      // 卸载删除授权记录（§17.7）；禁用不删。先删记录再重读静态表。
      if (change?.action === "uninstall" && change.pluginId) {
        void revokeGrants(change.pluginId, "uninstall").catch((error: unknown) => {
          logger.warn(undefined, "remove extension grants on uninstall failed", {
            code: (error as { code?: unknown } | null)?.code,
          });
        });
      }
      // 激活确认的记录（§17.7，P3b）：卸载删除；user 层重新启用也删除（设置页启用前已经确认过）。
      // 排在重读之前（同一条串行链），重读后的声明里就有这个插件。
      const clearHold =
        change?.pluginId &&
        (change.action === "uninstall" ||
          (change.action === "enable" && change.scope !== "workspace"))
          ? change.pluginId
          : null;
      if (clearHold) {
        void enqueueStatic("clear extension activation hold", async () => {
          if (await grants.clearActivation(clearHold))
            logger.info(undefined, `extension activation hold cleared plugin=${clearHold}`);
        });
      }
      refreshStatic("plugins changed", { installed: change?.action === "install" });
      // 扩展只认 user 层（§13）：workspace scope 的配置不改变 settings.get 的值。
      if (
        change?.pluginId &&
        (change.action === "configure" || change.action === "reset_config") &&
        change.scope !== "workspace"
      ) {
        settings.notifyChanged(change.pluginId);
      }
    },
    dispose() {
      disposed = true;
      detach("window host disposed");
      views.dispose();
      contextPump.dispose();
      generationPump.dispose();
      workbench.dispose();
      env.dispose();
      settings.dispose();
      reads.dispose();
      grantsSubscription.dispose();
      grantFactsChanged.dispose();
      grants.dispose();
      drafts.dispose();
      grantRequests.dispose();
      notifications.dispose();
      contributions.dispose();
      hostStatus.dispose();
      for (const request of logRequests.values()) {
        request.reject(new Error("extensions service disposed"));
      }
      logRequests.clear();
      logs.dispose();
    },
  };
}
