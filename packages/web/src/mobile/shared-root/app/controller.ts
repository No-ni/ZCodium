import type {
  WebRemoteControlBootstrapResult,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlWorkspaceSwitchOptions,
} from "@zcode/shared";
import type {
  MobileRootConnectionState,
  MobileRootDraftRequest,
  MobileRootNavigation,
  MobileRootSnapshot,
  MobileRootSlot,
  MobileRootWorkspaceAccess,
  MobileRootWorkspaceSwitcher,
  MobileSharedRootTransport,
} from "../contract.js";
import type { MobileRootAdapters, MobileRootController } from "./controller-types.js";
import {
  initialMobileRootNavigation,
  matchesMobileWorkspace,
  mobileWorkspace,
} from "../domain/navigation.js";
import { handoffMobileProjectDraft } from "./project-draft.js";
import { createMobileWorkspaceSwitcher, markMobileOpenedTaskRead } from "./workspace-actions.js";
import { createMobileRootSlot } from "./root-slot.js";

/** 只拥有 bridge 展示槽和恢复导航；SessionDataLayer/CommandInbox 继续拥有任务和输入。 */
export class SharedMobileRootController implements MobileRootController {
  private snapshot: MobileRootSnapshot = { slot: null, loading: true, error: false };
  private listeners = new Set<() => void>();
  private listListeners = new Set<(result: WebRemoteControlWorkspaceListResult) => void>();
  private connection: MobileRootConnectionState = "connecting";
  private bootstrap: WebRemoteControlBootstrapResult | null = null;
  private windowControlSessionId: string | null = null;
  private navigation: MobileRootNavigation | null = null;
  private sequence = 0;
  private opening: number | null = null;
  private releaseRegistry: (() => void) | undefined;
  private removeInvalidation: (() => void) | undefined;
  private active = false;

  constructor(
    private readonly client: MobileSharedRootTransport,
    private readonly adapters: MobileRootAdapters,
    private readonly onWorkspaceListUpdated: (result: WebRemoteControlWorkspaceListResult) => void,
  ) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start(): void {
    if (this.active) return;
    this.active = true;
    this.removeInvalidation = this.client.onSharedWorkspaceInvalidated(() => {
      this.clearSlot();
      this.publish({ slot: null, loading: true, error: false });
      // open 自身也会同步失效旧桥；此时由同一 opening 等候就绪，不能再开第二条链。
      if (this.opening === null) void this.reconcile();
    });
  }

  dispose(): void {
    this.active = false;
    this.sequence++;
    this.opening = null;
    this.removeInvalidation?.();
    this.removeInvalidation = undefined;
    const access = this.snapshot.slot?.access;
    if (access?.isCurrent()) this.client.updateMobileTaskView(null);
    this.clearSlot();
    this.publish({ slot: null, loading: true, error: false });
  }

  update(connection: MobileRootConnectionState, bootstrap: WebRemoteControlBootstrapResult | null) {
    this.connection = connection;
    this.bootstrap = bootstrap;
    if (!this.active) return;
    if (connection !== "paired" || !bootstrap) {
      this.sequence++;
      this.opening = null;
      this.clearSlot();
      this.publish({ slot: null, loading: true, error: false });
      return;
    }
    if (
      this.windowControlSessionId !== null &&
      this.windowControlSessionId !== bootstrap.windowControlSessionId
    ) {
      // 原因：断线期间 bootstrap 已清空，仍须用最后配对窗口身份拒绝旧 opening/恢复意图。
      this.sequence++;
      this.opening = null;
      this.navigation = null;
      this.clearSlot();
      this.publish({ slot: null, loading: true, error: false });
    }
    this.windowControlSessionId = bootstrap.windowControlSessionId;
    if (!this.navigation || !mobileWorkspace(bootstrap, this.navigation.workspaceKey))
      this.navigation = initialMobileRootNavigation(bootstrap);
    if (this.navigation) {
      const result = this.inventory();
      for (const listener of this.listListeners) listener(result);
    }
    void this.reconcile();
  }

  retry(): void {
    void this.reconcile();
  }

  private publish(snapshot: MobileRootSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private clearSlot() {
    const release = this.releaseRegistry;
    this.releaseRegistry = undefined;
    release?.();
  }

  private inventory(): WebRemoteControlWorkspaceListResult {
    if (!this.bootstrap || !this.navigation) throw new Error("mobile-workspace-unavailable");
    return {
      workspaces: this.bootstrap.workspaces,
      tasks: this.bootstrap.tasks,
      activeWorkspaceKey: this.navigation.workspaceKey,
      ...(this.navigation.taskId ? { activeTaskId: this.navigation.taskId } : {}),
    };
  }

  private assertAccess(access: MobileRootWorkspaceAccess) {
    if (!this.active || this.connection !== "paired" || !access.isCurrent())
      throw new Error("mobile-workspace-superseded");
  }

  private assertWindow(windowControlSessionId: string) {
    if (
      !this.active ||
      this.connection !== "paired" ||
      this.bootstrap?.windowControlSessionId !== windowControlSessionId ||
      this.windowControlSessionId !== windowControlSessionId
    )
      throw new Error("mobile-workspace-superseded");
  }

  private async readWorkspaceList(assertCurrent: () => void) {
    assertCurrent();
    const response = await this.client.request({
      zcode_type: "workspace-list-request",
      requestId: `mobile-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    assertCurrent();
    if (response.zcode_type !== "workspace-list-response")
      throw new Error("mobile-workspace-list-unavailable");
    if (this.bootstrap)
      this.bootstrap = {
        ...this.bootstrap,
        workspaces: response.result.workspaces,
        tasks: response.result.tasks,
      };
    this.onWorkspaceListUpdated(response.result);
    for (const listener of this.listListeners) listener(response.result);
    return response.result;
  }

  private makeSwitcher(
    access: MobileRootWorkspaceAccess,
    isCurrent: () => boolean,
  ): MobileRootWorkspaceSwitcher {
    const assertCurrent = () => {
      if (!isCurrent()) throw new Error("mobile-workspace-superseded");
    };
    return createMobileWorkspaceSwitcher(access, {
      client: this.client,
      isCurrent,
      assertAccess: () => assertCurrent(),
      readWorkspaceList: () => this.readWorkspaceList(assertCurrent),
      subscribeList: (listener) => {
        this.listListeners.add(listener);
        return () => {
          this.listListeners.delete(listener);
        };
      },
      navigate: (key, options) => this.navigate(key, options),
      openProjectDraft: (candidate, request) =>
        this.openProjectDraft(candidate, request, isCurrent),
      updateNavigation: (key, taskId) => {
        if (this.navigation?.workspaceKey === key)
          this.navigation = {
            ...this.navigation,
            taskId,
            draft: undefined,
            mobileNavigationIntent: undefined,
          };
      },
      reconnectWorkspace: (candidate, key) =>
        this.reconnectWorkspace(candidate, key, assertCurrent),
    });
  }

  private async reconnectWorkspace(
    access: MobileRootWorkspaceAccess,
    key: string,
    assertCurrent: () => void,
  ) {
    assertCurrent();
    this.assertAccess(access);
    const windowId = this.bootstrap!.windowControlSessionId;
    const navigation = this.navigation!;
    const assertReconnectCurrent = () => {
      this.assertWindow(windowId);
      if (
        this.navigation?.revision !== navigation.revision ||
        this.navigation?.workspaceKey !== navigation.workspaceKey ||
        this.navigation?.taskId !== navigation.taskId
      )
        throw new Error("mobile-workspace-superseded");
    };
    if (!mobileWorkspace(this.bootstrap, key))
      throw new Error("mobile-workspace-scope-unavailable");
    const response = await this.client.request({
      zcode_type: "workspace-reconnect-request",
      workspaceKey: key,
      requestId: `mobile-reconnect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    // 原因：成功重连会替换旧 bridge；校验同配对窗口和目标，不能要求旧 accessor 继续存活。
    assertReconnectCurrent();
    if (
      response.zcode_type !== "workspace-reconnect-response" ||
      !response.success ||
      response.workspaceKey !== key
    )
      throw new Error("mobile-workspace-reconnect-unavailable");
    await this.readWorkspaceList(assertReconnectCurrent);
    await this.reconcile();
  }

  private async openProjectDraft(
    access: MobileRootWorkspaceAccess,
    request: MobileRootDraftRequest,
    isCurrent: () => boolean,
  ) {
    this.assertAccess(access);
    await handoffMobileProjectDraft(access, request, {
      isCurrent,
      list: () =>
        this.readWorkspaceList(() => {
          if (!isCurrent()) throw new Error("mobile-workspace-superseded");
        }),
      navigate: (key, draft, onAdmitted) =>
        this.navigate(key, { mobileNavigationIntent: "chat" }, draft, onAdmitted),
      reportFailure: () => this.publish({ ...this.snapshot, loading: false, error: true }),
    });
  }

  private async navigate(
    key: string,
    options?: WebRemoteControlWorkspaceSwitchOptions,
    draft?: MobileRootDraftRequest,
    onAdmitted?: (isCurrent: () => boolean) => void,
  ) {
    const workspace = mobileWorkspace(this.bootstrap, key);
    if (!workspace || (workspace.kind === "remote" && workspace.connectionState !== "connected"))
      throw new Error("mobile-workspace-unavailable");
    if (
      options?.taskId &&
      !this.bootstrap?.tasks.some(
        (task) => task.taskId === options.taskId && task.workspaceKey === key,
      )
    )
      throw new Error("mobile-task-unavailable");
    this.navigation = {
      workspaceKey: key,
      taskId: options?.taskId,
      revision: (this.navigation?.revision ?? 0) + 1,
      mobileNavigationIntent: options?.mobileNavigationIntent,
      fileTreeTaskId: options?.fileTreeTaskId,
      draft,
    };
    const navigation = this.navigation;
    const sequence = this.sequence + 1;
    const windowId = this.windowControlSessionId;
    onAdmitted?.(() => {
      const current = mobileWorkspace(this.bootstrap, key);
      return (
        this.active &&
        this.connection === "paired" &&
        sequence === this.sequence &&
        this.windowControlSessionId === windowId &&
        this.bootstrap?.windowControlSessionId === windowId &&
        this.navigation?.revision === navigation.revision &&
        this.navigation?.workspaceKey === key &&
        Boolean(
          current &&
          matchesMobileWorkspace(workspace, current) &&
          (current.kind !== "remote" || current.connectionState === "connected"),
        )
      );
    });
    await markMobileOpenedTaskRead(await this.reconcile(true), options);
  }

  private async reconcile(force = false) {
    if (!this.active || this.connection !== "paired" || !this.bootstrap) {
      if (force) throw new Error("mobile-workspace-superseded");
      return;
    }
    const windowId = this.bootstrap.windowControlSessionId;
    const navigation = this.navigation;
    const workspace = mobileWorkspace(this.bootstrap, navigation?.workspaceKey);
    if (!navigation || !workspace) {
      this.clearSlot();
      this.publish({ slot: null, loading: false, error: true });
      if (force) throw new Error("mobile-workspace-unavailable");
      return;
    }
    const old = this.snapshot.slot?.access;
    if (!force && old?.isCurrent() && matchesMobileWorkspace(old.descriptor, workspace)) return;
    if (!force && this.opening !== null) return;
    const sequence = ++this.sequence;
    this.opening = sequence;
    this.clearSlot();
    this.publish({ slot: null, loading: true, error: false });
    try {
      const access = await this.client.openSharedWorkspace({
        workspaceKey: workspace.workspaceKey,
        remoteSessionId: workspace.remoteSessionId,
        taskId: navigation.taskId,
      });
      const currentWorkspace = mobileWorkspace(this.bootstrap, navigation.workspaceKey);
      if (
        !this.active ||
        sequence !== this.sequence ||
        this.navigation?.revision !== navigation.revision ||
        this.navigation?.workspaceKey !== navigation.workspaceKey ||
        !currentWorkspace ||
        !matchesMobileWorkspace(workspace, currentWorkspace) ||
        (currentWorkspace.kind === "remote" && currentWorkspace.connectionState !== "connected")
      ) {
        if (force) throw new Error("mobile-workspace-superseded");
        return;
      }
      this.assertWindow(windowId);
      this.assertAccess(access);
      if (!matchesMobileWorkspace(access.descriptor, workspace))
        throw new Error("mobile-workspace-scope-unavailable");
      this.releaseRegistry = this.adapters.registerWorkspace(access);
      // 同 bridge 切 task/草稿时旧 accessor 仍有效；所有回调都须借同一个 slot 租约。
      const isCurrent = (): boolean =>
        this.active &&
        this.connection === "paired" &&
        sequence === this.sequence &&
        this.bootstrap?.windowControlSessionId === windowId &&
        this.windowControlSessionId === windowId &&
        access.isCurrent() &&
        this.snapshot.slot === slot;
      const slot: MobileRootSlot = createMobileRootSlot(
        access,
        navigation,
        windowId,
        this.adapters.createPlatform(access),
        this.makeSwitcher(access, isCurrent),
        isCurrent,
      );
      this.assertWindow(windowId);
      this.assertAccess(access);
      this.publish({
        loading: false,
        error: false,
        slot,
      });
      return slot;
    } catch {
      if (
        this.active &&
        sequence === this.sequence &&
        this.navigation?.revision === navigation.revision &&
        this.navigation?.workspaceKey === navigation.workspaceKey
      ) {
        this.clearSlot();
        this.publish({ slot: null, loading: false, error: true });
      }
      // 只有后台恢复可将失败投影为状态；用户发起的强制导航不能报告假成功。
      if (force) throw new Error("mobile-workspace-navigation-unavailable");
    } finally {
      if (this.opening === sequence) {
        this.opening = null;
        // 清单可能在 opening 期间撤销原目标；旧结果结束后恢复新的可信导航，不复活旧 slot。
        if (this.active && this.navigation?.revision !== navigation.revision) void this.reconcile();
      }
    }
  }
}
