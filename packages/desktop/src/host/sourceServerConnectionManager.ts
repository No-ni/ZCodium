import { retireSourceProfiles } from "./sourceServerProfileRetirement.js";
import {
  createSourceConnectionFlight,
  joinSourceConnectionFlight,
  releaseManagedSource,
  createManagedSourceHandle,
} from "./sourceServerConnectionFlights.js";
import { Emitter } from "@zcode/rpc";
import {
  evaluateSourceServerCompatibility,
  ZCODE_COMPATIBILITY_MANIFEST,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerConnectionStateSnapshot,
  type SourceServerDirectorySnapshot,
  type SourceServerRunningTasksResult,
} from "@zcode/shared";
import type { SourceServerTransport } from "@zcode/server/source-server";
import { connectSourceServerRpc, type SourceServerRpcConnection } from "./sourceServerRpc.js";
import { SourceServerDirectoryError } from "./sourceServerDirectory.js";
import { SourceServerOperationFlights } from "./sourceServerOperationFlights.js";
import type {
  OnlineSource,
  Flight,
  ManagedSourceHandle,
  ManagerOptions,
} from "./sourceServerConnectionTypes.js";
export type { ManagedSourceHandle } from "./sourceServerConnectionTypes.js";

export class SourceServerConnectionManager {
  private nextGeneration = 1;
  private readonly online = new Map<string, OnlineSource>();
  private readonly flights = new Map<string, Flight>();
  private readonly activeFlights = new Set<Flight>();
  private readonly operations: SourceServerOperationFlights;
  private readonly activeDisposals = new Set<Promise<void>>();
  private disposal?: Promise<void>;
  private readonly states = new Map<string, SourceServerConnectionStateSnapshot>();
  private readonly changes = new Emitter<void>();
  private readonly directorySubscription: { dispose(): void };
  private directoryGeneration = -1;
  private readonly directoryBootstrap: Promise<void>;
  private closed = false;
  readonly onDidChange = this.changes.event;

  constructor(private readonly options: ManagerOptions) {
    this.operations = new SourceServerOperationFlights({
      directory: options.directory,
      executeCommand: options.executeCommand,
      isClosed: () => this.closed,
      setState: (profile, state, code) => this.setState(profile, state, code),
      reconnect: (profile, target, signal) => this.connect(profile, target, signal),
      beforeLifecycle: async (profile, signal) => {
        const pending = [...this.activeFlights].filter(
          (flight) =>
            flight.profile.sourceServerId === profile.sourceServerId ||
            flight.profile.profileId === profile.profileId,
        );
        for (const flight of pending) flight.controller.abort();
        await Promise.allSettled(pending.map((flight) => flight.promise));
        await options.beforeLifecycle?.(profile.sourceServerId!, signal);
        await this.disconnect(profile.sourceServerId!);
      },
    });
    this.directorySubscription = options.directory.onDidChange((snapshot) =>
      this.retireStaleProfiles(snapshot),
    );
    this.directoryBootstrap = options.directory
      .snapshot()
      .then((snapshot) => this.retireStaleProfiles(snapshot))
      .catch(() => undefined);
  }

  listStates(): SourceServerConnectionStateSnapshot[] {
    return [...this.states.values()];
  }

  getOnlineSource(sourceServerId: string) {
    const source = this.online.get(sourceServerId);
    // Bot 与设置共用物理 owner；读取不能为离线或显式操作中的设备新建连接。
    if (
      this.closed ||
      !source ||
      source.connection.isClosed ||
      this.operations.isBusy(sourceServerId)
    )
      return undefined;
    return {
      owner: source.connection,
      services: source.connection.services,
      generation: source.generation,
      workspaceInspection: source.connection.workspaceInspection,
    };
  }

  getSettingsScope(sourceServerId: string): {
    services: SourceServerRpcConnection["services"];
    generation: number;
  } {
    const source = this.getOnlineSource(sourceServerId);
    if (!source) throw new Error("Source settings generation is offline");
    return { services: source.services, generation: source.generation };
  }

  private setState(
    profile: ConnectionProfile,
    state: SourceServerConnectionStateSnapshot["state"],
    errorCode?: SourceServerConnectionStateSnapshot["errorCode"],
    pendingSourceServerId?: string,
  ): void {
    if (this.closed) return;
    this.states.set(profile.profileId, {
      profileId: profile.profileId,
      generation: profile.generation,
      ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
      state,
      ...(errorCode ? { errorCode } : {}),
      ...(pendingSourceServerId ? { pendingSourceServerId } : {}),
      updatedAt: Date.now(),
    });
    this.changes.fire();
  }

  async retain(
    profile: ConnectionProfile,
    target: RemoteTarget,
    signal?: AbortSignal,
    expectedSourceServerId?: string,
  ): Promise<ManagedSourceHandle> {
    if (this.closed) throw new Error("Source manager is closed");
    this.operations.assertNotBusy(profile.sourceServerId);
    signal?.throwIfAborted();
    const admittedProfile = await this.options.directory.assertCurrent(profile);
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Source manager is closed");
    this.operations.assertNotBusy(admittedProfile.sourceServerId);
    let source =
      !expectedSourceServerId && admittedProfile.sourceServerId
        ? this.online.get(admittedProfile.sourceServerId)
        : undefined;
    if (!source || source.connection.isClosed) {
      const key = `${profile.profileId}:${profile.generation}:${expectedSourceServerId ?? "normal"}`;
      let flight = this.flights.get(key);
      if (!flight || flight.controller.signal.aborted)
        flight = createSourceConnectionFlight(
          admittedProfile,
          target,
          key,
          expectedSourceServerId,
          this.flights,
          this.activeFlights,
          (profile, target, signal, expectedId) =>
            this.connect(profile, target, signal, expectedId),
        );
      source = await joinSourceConnectionFlight(flight, signal);
    }
    signal?.throwIfAborted();
    const current = await this.options.directory.assertCurrent(
      expectedSourceServerId
        ? {
            profileId: profile.profileId,
            generation:
              admittedProfile.generation +
              Number(
                Boolean(
                  admittedProfile.sourceServerId &&
                  admittedProfile.sourceServerId !== expectedSourceServerId,
                ),
              ),
          }
        : profile,
    );
    signal?.throwIfAborted();
    this.operations.assertNotBusy(source.connection.serverInfo.serverId);
    if (
      this.closed ||
      source.connection.isClosed ||
      this.online.get(source.connection.serverInfo.serverId) !== source
    ) {
      throw new Error("Source generation is offline");
    }
    if (expectedSourceServerId && current.sourceServerId !== expectedSourceServerId)
      throw new Error("Source identity confirmation is stale");
    this.setState(current, "online");
    return createManagedSourceHandle(source, current);
  }

  private async connect(
    profile: ConnectionProfile,
    target: RemoteTarget,
    signal: AbortSignal,
    expectedSourceServerId?: string,
  ): Promise<OnlineSource> {
    this.setState(profile, "connecting");
    let transport: SourceServerTransport | undefined;
    let connection: SourceServerRpcConnection | undefined;
    let closeSubscription: { dispose(): void } | undefined;
    let source: OnlineSource | undefined;
    let didClose = false;
    let published = false;
    try {
      // 本地 Host 不应静态加载 ssh2；仅实际远端连接时进入 transport adapter。
      const connectTransport =
        this.options.connectTransport ??
        (await import("@zcode/server/source-server")).connectSourceServerTransport;
      signal.throwIfAborted();
      transport = await connectTransport(target, { signal });
      signal.throwIfAborted();
      connection = await (this.options.connectRpc ?? connectSourceServerRpc)(transport, signal);
      closeSubscription = connection.onDidClose(() => {
        didClose = true;
        if (
          !published ||
          !source ||
          this.online.get(source.connection.serverInfo.serverId) !== source
        )
          return;
        this.online.delete(source.connection.serverInfo.serverId);
        for (const state of this.states.values()) {
          if (
            state.sourceServerId === source.connection.serverInfo.serverId &&
            state.state === "online"
          ) {
            this.setState(
              { ...source.profile, profileId: state.profileId, generation: state.generation },
              "offline",
            );
          }
        }
        void releaseManagedSource(source, this.activeDisposals).catch(() => undefined);
      });
      const assertLive = () => {
        signal.throwIfAborted();
        if (this.closed || didClose || connection!.isClosed)
          throw new Error("Source closed before publication");
      };
      assertLive();
      if (
        !connection.serverInfo.compatibility ||
        !evaluateSourceServerCompatibility(
          ZCODE_COMPATIBILITY_MANIFEST,
          connection.serverInfo.compatibility,
        ).compatible
      ) {
        throw Object.assign(new Error("Source upgrade is required"), {
          code: "source-server-upgrade-required",
        });
      }
      const current = await this.options.directory.recordHandshake(profile, connection.serverInfo, {
        authenticatedTarget: target,
        ...(expectedSourceServerId ? { expectedSourceServerId } : {}),
      });
      assertLive();
      const sameSource = this.online.get(connection.serverInfo.serverId);
      if (sameSource && !sameSource.connection.isClosed) {
        this.setState(current, "online");
        return sameSource;
      }
      source = {
        generation: this.nextGeneration++,
        profile: current,
        transport,
        connection,
        references: 0,
        closeSubscription,
      };
      await this.options.beforePublish?.(source);
      assertLive();
      await this.options.directory.assertCurrent(current);
      assertLive();
      const afterSync = this.online.get(connection.serverInfo.serverId);
      if (afterSync && !afterSync.connection.isClosed) {
        this.setState(current, "online");
        return afterSync;
      }
      this.online.set(connection.serverInfo.serverId, source);
      published = true;
      this.setState(current, "online");
      return source;
    } catch (error) {
      if (!signal.aborted && !this.closed) {
        const current = await this.options.directory.assertCurrent(profile).catch(() => null);
        if (current) {
          const code =
            error instanceof SourceServerDirectoryError
              ? error.code
              : error && typeof error === "object" && "code" in error
                ? error.code
                : undefined;
          const state =
            code === "source-server-install-required"
              ? "needs-install"
              : code === "source-server-start-required"
                ? "needs-start"
                : code === "source-server-upgrade-required"
                  ? "needs-upgrade"
                  : code === "source-server-identity-change-pending"
                    ? "identity-change-pending"
                    : "failed";
          this.setState(
            current,
            state,
            state === "failed"
              ? "source-server-connection-failed"
              : (code as SourceServerConnectionStateSnapshot["errorCode"]),
            error instanceof SourceServerDirectoryError ? error.pendingSourceServerId : undefined,
          );
        }
      }
      throw error;
    } finally {
      if (!published) {
        closeSubscription?.dispose();
        connection?.dispose();
        await transport?.dispose();
      }
    }
  }

  private retireStaleProfiles(snapshot: SourceServerDirectorySnapshot): void {
    // 异步读取的旧目录曾关闭新连接；退休只消费已经提交的递增快照。
    if (this.closed || snapshot.generation <= this.directoryGeneration) return;
    this.directoryGeneration = snapshot.generation;
    retireSourceProfiles(snapshot, {
      operations: this.operations,
      activeFlights: this.activeFlights,
      online: this.online,
      states: this.states,
      activeDisposals: this.activeDisposals,
      changes: this.changes,
      setState: (profile, state) => this.setState(profile, state),
    });
  }

  async disconnect(sourceServerId: string): Promise<void> {
    const source = this.online.get(sourceServerId);
    if (!source) return;
    this.online.delete(sourceServerId);
    await releaseManagedSource(source, this.activeDisposals);
    for (const state of this.states.values()) {
      if (state.sourceServerId === sourceServerId)
        this.setState(
          { ...source.profile, profileId: state.profileId, generation: state.generation },
          "offline",
        );
    }
  }

  stopSource(profile: ConnectionProfile, target: RemoteTarget): Promise<void> {
    return this.operations.run(profile, target, "stop");
  }

  restartSource(profile: ConnectionProfile, target: RemoteTarget): Promise<void> {
    return this.operations.run(profile, target, "restart");
  }

  getRunningTasks(
    profile: ConnectionProfile,
    target: RemoteTarget,
  ): Promise<SourceServerRunningTasksResult> {
    return this.operations.getRunningTasks(profile, target);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.directorySubscription.dispose();
    const pending = [...this.activeFlights];
    const operations = this.operations.dispose();
    for (const flight of pending) flight.controller.abort();
    this.flights.clear();
    this.disposal = (async () => {
      await this.directoryBootstrap;
      await Promise.allSettled(pending.map((flight) => flight.promise));
      await operations;
      await Promise.allSettled(
        Array.from(this.online.values(), (source) =>
          releaseManagedSource(source, this.activeDisposals),
        ),
      );
      // 已离线连接也可能仍在释放 transport；退出不能只等待 online map 的剩余对象。
      await Promise.allSettled(Array.from(this.activeDisposals));
      this.online.clear();
      this.changes.dispose();
    })();
    return this.disposal;
  }
}
