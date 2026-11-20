import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Emitter, type Event } from "@zcode/rpc";
import {
  executeCommandInputSchema,
  decideExtensionActivationInputSchema,
  describeExtensionEnableInputSchema,
  extensionEnvSchema,
  getExtensionRecentActionsInputSchema,
  grantExtensionInputSchema,
  revokeExtensionInputSchema,
  notificationsShowResultSchema,
  setExtensionNotificationsInputSchema,
  extensionViewInputSchema,
  getExtensionLogsInputSchema,
  provideMentionItemsInputSchema,
  resolvePluginManifest,
  resolvedScopeSchema,
  viewRequestInputSchema,
  workbenchReportSchema,
  type ExtensionGrantsSnapshot,
  type ExtensionHostStatus,
  type ExtensionLogEntry,
  type ExtensionLogsSnapshot,
} from "@zcode/shared/extension-host";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { createExtensionDraftRelay } from "#src/extensions/draftRelay.js";
import { createEnvState } from "#src/extensions/envState.js";
import { readPluginManifest } from "#src/extensions/manifestReader.js";
import { createMentionItemsRouter } from "#src/extensions/mentionItems.js";
import { createAuditLog } from "#src/extensions/auditLog.js";
import { createGrantsStore } from "#src/extensions/grantsStore.js";
import { createGrantRequestRelay } from "#src/extensions/grantRequestRelay.js";
import { createNotificationRelay } from "#src/extensions/notificationRelay.js";
import { createSessionsBackend } from "#src/extensions/sessionsBackend.js";
import { createExtensionViewRelay } from "#src/extensions/viewRelay.js";
import { createWorkbenchState } from "#src/extensions/workbenchState.js";
import type {
  ExtensionsContributionsMessage,
  IExtensionsService,
} from "#src/extensions/contract.js";
import type { IExtensionViewsService } from "#src/extensions/views/contract.js";
import type { IExtensionGrantsService } from "#src/extensions/grants/contract.js";
import { type WindowHostExtensionsDeps } from "./windowHostExtensionsTypes.js";
import type { WindowExtensionState } from "./windowHostExtensionsTypes.js";
interface Context {
  state: WindowExtensionState;
  deps: WindowHostExtensionsDeps;
  grants: ReturnType<typeof createGrantsStore>;
  audit: ReturnType<typeof createAuditLog>;
  sessions: ReturnType<typeof createSessionsBackend>;
  logger: ReturnType<typeof createServiceLogger>;
  contributions: Emitter<ExtensionsContributionsMessage>;
  hostStatus: Emitter<ExtensionHostStatus>;
  logs: Emitter<ExtensionLogEntry[]>;
  logRequests: Map<
    string,
    { resolve(snapshot: ExtensionLogsSnapshot): void; reject(error: Error): void }
  >;
  provideMentionItems: ReturnType<typeof createMentionItemsRouter>;
  workbench: ReturnType<typeof createWorkbenchState>;
  env: ReturnType<typeof createEnvState>;
  grantRequests: ReturnType<typeof createGrantRequestRelay>;
  views: ReturnType<typeof createExtensionViewRelay>;
  drafts: ReturnType<typeof createExtensionDraftRelay>;
  notifications: ReturnType<typeof createNotificationRelay>;
  enqueueStatic(label: string, task: () => Promise<void>): Promise<void>;
  publishStatic(reason: string): void;
  pushDeclarations(): Promise<void>;
  refreshStatic(reason: string, options?: { installed?: boolean }): Promise<void>;
}
export function createWindowExtensionFacades({
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
}: Context) {
  const service: IExtensionsService = {
    onDynamicContributions: () =>
      ((listener: (message: ExtensionsContributionsMessage) => void) => {
        listener({ kind: "static", table: state.table });
        listener(state.snapshot ?? { kind: "detached" });
        return contributions.event(listener);
      }) satisfies Event<ExtensionsContributionsMessage>,
    onDynamicHostStatus: () =>
      ((listener: (next: ExtensionHostStatus) => void) => {
        listener(state.status);
        return hostStatus.event(listener);
      }) satisfies Event<ExtensionHostStatus>,
    async executeCommand(input) {
      const parsed = executeCommandInputSchema.parse(input);
      const target = state.connection;
      if (!target) throw new Error("extension host is not connected");
      await target.host.executeCommand(parsed);
    },
    provideMentionItems: (input) =>
      provideMentionItems(provideMentionItemsInputSchema.parse(input)),
    async reload() {
      logger.info(undefined, "reload extensions requested");
      // 先请 Main 重启：不等清单读取，扩展进程卡死或已停止时也能马上生效。新代际牵线时的推送排在
      // 这次重读之后，拿到的是重读后的声明。
      deps.postToMain({ type: "extension-host/reload" });
      refreshStatic("reload");
    },
    async reportWorkbench(report) {
      const parsed = workbenchReportSchema.parse(report);
      workbench.report(parsed);
      // 窗格与焦点变化才报告，频率低。
      logger.info(
        undefined,
        `workbench report sessions=${parsed.sessions.length} drafts=${parsed.sessions.filter((session) => session.isDraft).length}`,
      );
    },
    async reportEnv(next) {
      const parsed = extensionEnvSchema.parse(next);
      // 只在语言变化时报告，频率低。
      logger.info(undefined, `env report locale=${parsed.locale}`);
      env.report(parsed);
    },
    getLogs(input) {
      const parsed = getExtensionLogsInputSchema.parse(input ?? {});
      if (state.disposed) return Promise.reject(new Error("extensions service disposed"));
      const requestId = randomUUID();
      return new Promise<ExtensionLogsSnapshot>((resolve, reject) => {
        logRequests.set(requestId, { resolve, reject });
        try {
          deps.postToMain({ type: "extension-host/logs-request", requestId, ...parsed });
        } catch (error) {
          logRequests.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    onDynamicLogs: () => logs.event,
  };

  /** 授权与撤销各记一行审计（§17.8）。 */
  const auditGrantChange = (
    pluginId: string,
    capability: "grants.grant" | "grants.revoke",
    tiers: readonly string[],
  ) =>
    audit.append({
      gen: state.connection?.gen ?? null,
      pluginId,
      capability,
      ...(tiers.includes("sessions.fullAccess")
        ? { grant: "sessions.fullAccess" as const }
        : tiers.includes("sessions.write")
          ? { grant: "sessions.write" as const }
          : tiers.includes("sessions.read")
            ? { grant: "sessions.read" as const }
            : tiers.includes("notifications")
              ? { grant: "notifications" as const }
              : {}),
      outcome: "ok",
    });

  const revokeGrants = async (pluginId: string, reason: string) => {
    const revoked = await grants.revoke(pluginId, (tiers) =>
      auditGrantChange(pluginId, "grants.revoke", tiers),
    );
    sessions.abortPlugin(pluginId);
    if (revoked.length === 0) return;
    logger.info(
      undefined,
      `extension grants revoked plugin=${pluginId} tiers=${revoked.join(",")} (${reason})`,
    );
  };

  const grantsService: IExtensionGrantsService = {
    onDynamicGrants: () =>
      ((listener: (snapshot: ExtensionGrantsSnapshot) => void) => {
        listener(grants.snapshot());
        return grants.onDidChange(listener);
      }) satisfies Event<ExtensionGrantsSnapshot>,
    async grant(input) {
      const parsed = grantExtensionInputSchema.parse(input);
      const granted = await grants.grant(parsed.pluginId, parsed.grants, (tiers) =>
        auditGrantChange(parsed.pluginId, "grants.grant", tiers),
      );
      logger.info(
        undefined,
        `extension grants granted plugin=${parsed.pluginId} tiers=${granted.join(",")}`,
      );
    },
    async revoke(input) {
      await revokeGrants(revokeExtensionInputSchema.parse(input).pluginId, "user");
    },
    async describeEnable(input) {
      const { pluginId } = describeExtensionEnableInputSchema.parse(input);
      const holders = grants.holders(pluginId);
      if (holders.length === 0) return { confirm: false, holders: [] };
      // 只有带扩展代码（合法、兼容、有 main）的插件需要确认：别的插件启用后没有代码在扩展进程里运行。
      const result = await deps.pluginManagement.listPlugins({
        workspacePath: deps.inventoryWorkspacePath,
        configScope: "user",
      });
      const plugin = result.plugins.find((candidate) => candidate.id === pluginId);
      if (!plugin || plugin.packageStatus === "missing") return { confirm: false, holders };
      const { entry } = resolvePluginManifest(
        { pluginId, name: plugin.name, rootPath: plugin.rootPath },
        await readPluginManifest(plugin.rootPath),
      );
      const hasCode = entry.extension?.state === "ok" && Boolean(entry.extension.main);
      return { confirm: hasCode, holders };
    },
    async getRecentActions(input) {
      const parsed = getExtensionRecentActionsInputSchema.parse(input);
      return { entries: await audit.recent(parsed.pluginId, parsed.limit) };
    },
    async decideActivation(input) {
      const { pluginId, allow } = decideExtensionActivationInputSchema.parse(input);
      // 与静态表重读同一条串行链：决定写进 grants.json 后按最近一份清单重发静态表与声明。
      await enqueueStatic("decide extension activation", async () => {
        if (!(await grants.decideActivation(pluginId, allow)))
          throw new Error("the extension is not waiting for activation");
        logger.info(
          undefined,
          `extension activation ${allow ? "allowed" : "declined"} plugin=${pluginId}`,
        );
        publishStatic(allow ? "activation allowed" : "activation declined");
        await pushDeclarations();
      });
    },
    async setNotificationsEnabled(input) {
      const { pluginId, enabled } = setExtensionNotificationsInputSchema.parse(input);
      const changed = await grants.setNotificationsEnabled(pluginId, enabled, async () => {
        await audit.append({
          gen: state.connection?.gen ?? null,
          pluginId,
          capability: enabled ? "grants.notifications.on" : "grants.notifications.off",
          grant: "notifications",
          outcome: "ok",
        });
      });
      if (changed) {
        logger.info(
          undefined,
          `extension notifications ${enabled ? "on" : "off"} plugin=${pluginId}`,
        );
      }
    },
    onDynamicGrantRequests: () => grantRequests.onRequests,
    async ackGrantRequest(ack) {
      grantRequests.ack(ack);
    },
  };

  const viewsService: IExtensionViewsService = {
    prepareView: (input) =>
      views.prepareView({
        ...input,
        scope: resolvedScopeSchema.parse(input.scope),
        ...(input.input ? { input: extensionViewInputSchema.parse(input.input) } : {}),
      }),
    viewRequest: (input) => views.viewRequest(viewRequestInputSchema.parse(input)),
    closeView: (input) => views.closeView(input.instanceId),
    onDynamicViewNotifications: (input) => views.onViewNotifications(input.instanceId),
    onDynamicViewOpenRequests: () => views.onOpenRequests,
    async ackViewOpen(ack) {
      views.ackOpen(ack);
    },
    onDynamicDraftRequests: () => drafts.onRequests,
    async ackDraftRequest(ack) {
      drafts.ack(ack);
    },
    onDynamicNotificationRequests: () => notifications.onRequests,
    async ackNotificationRequest(ack) {
      notifications.ack({
        requestId: ack.requestId,
        result: notificationsShowResultSchema.parse(ack.result),
      });
    },
  };
  return { service, revokeGrants, grantsService, viewsService };
}
