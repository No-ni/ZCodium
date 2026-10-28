import { Emitter } from "@zcode/rpc";
import {
  evaluateSourceServerCompatibility,
  ZCODE_COMPATIBILITY_MANIFEST,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerConnectionStateSnapshot,
  type SourceServerDirectorySnapshot,
} from "@zcode/shared";
import type { SourceServerTransport } from "@zcode/server/source-server";
import { connectSourceServerRpc, type SourceServerRpcConnection } from "./sourceServerRpc.js";
import { SourceServerDirectoryError } from "./sourceServerDirectory.js";
import type {
  OnlineSource,
  Flight,
  ManagedSourceHandle,
  ManagerOptions,
} from "./sourceServerConnectionTypes.js";
export type { ManagedSourceHandle } from "./sourceServerConnectionTypes.js";

export class SourceServerConnectionManager {
  private readonly online = new Map<string, OnlineSource>();
  private readonly flights = new Map<string, Flight>();
  private readonly activeFlights = new Set<Flight>();
  private readonly states = new Map<string, SourceServerConnectionStateSnapshot>();
  private readonly changes = new Emitter<void>();
  private readonly directorySubscription: { dispose(): void };
  private directoryGeneration = -1;
  private readonly directoryBootstrap: Promise<void>;
  private closed = false;
  readonly onDidChange = this.changes.event;

  constructor(private readonly options: ManagerOptions) {
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

  private createFlight(
    profile: ConnectionProfile,
    target: RemoteTarget,
    key: string,
    expectedSourceServerId?: string,
  ): Flight {
    const controller = new AbortController();
    const flight: Flight = {
      profile,
      controller,
      waiters: 0,
      settled: false,
      expectedSourceServerId,
      promise: Promise.resolve().then(() =>
        this.connect(profile, target, controller.signal, expectedSourceServerId),
      ),
    };
    flight.promise = flight.promise.finally(() => {
      flight.settled = true;
      this.activeFlights.delete(flight);
      if (this.flights.get(key) === flight) this.flights.delete(key);
    });
    this.flights.set(key, flight);
    this.activeFlights.add(flight);
    return flight;
  }

  private async joinFlight(flight: Flight, signal?: AbortSignal): Promise<OnlineSource> {
    flight.waiters += 1;
    let abort: (() => void) | undefined;
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Source connection canceled"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    try {
      return await Promise.race([flight.promise, canceled]);
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      flight.waiters -= 1;
      // 一个 attachment 取消不能中断共享握手；只有最后一位等待者退出才退休准备代际。
      if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
    }
  }

  async retain(
    profile: ConnectionProfile,
    target: RemoteTarget,
    signal?: AbortSignal,
    expectedSourceServerId?: string,
  ): Promise<ManagedSourceHandle> {
    if (this.closed) throw new Error("Source manager is closed");
    signal?.throwIfAborted();
    const admittedProfile = await this.options.directory.assertCurrent(profile);
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Source manager is closed");
    let source =
      !expectedSourceServerId && admittedProfile.sourceServerId
        ? this.online.get(admittedProfile.sourceServerId)
        : undefined;
    if (!source || source.connection.isClosed) {
      const key = `${profile.profileId}:${profile.generation}:${expectedSourceServerId ?? "normal"}`;
      let flight = this.flights.get(key);
      if (!flight || flight.controller.signal.aborted)
        flight = this.createFlight(admittedProfile, target, key, expectedSourceServerId);
      source = await this.joinFlight(flight, signal);
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
    source.references += 1;
    let released = false;
    const captured = source;
    return {
      sourceServerId: captured.connection.serverInfo.serverId,
      profile: current,
      services: captured.connection.services,
      workspaceInspection: captured.connection.workspaceInspection,
      backend: captured.transport.backend,
      onDidClose: captured.connection.onDidClose,
      async dispose() {
        if (released) return;
        released = true;
        captured.references -= 1;
      },
    };
  }

  private releaseSource(source: OnlineSource): Promise<void> {
    if (source.disposal) return source.disposal;
    source.closeSubscription?.dispose();
    source.connection.dispose();
    source.disposal = source.transport.dispose();
    return source.disposal;
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
        void this.releaseSource(source).catch(() => undefined);
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
      source = { profile: current, transport, connection, references: 0, closeSubscription };
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
    for (const flight of this.activeFlights) {
      const current = snapshot.profiles.find(
        (profile) => profile.profileId === flight.profile.profileId,
      );
      const acceptedConfirmation = Boolean(
        flight.expectedSourceServerId &&
        current?.sourceServerId === flight.expectedSourceServerId &&
        current.generation === flight.profile.generation + 1,
      );
      if (acceptedConfirmation) flight.profile = current!;
      else if (!current || current.generation !== flight.profile.generation)
        flight.controller.abort();
    }
    for (const [id, source] of this.online) {
      if (
        snapshot.profiles.some(
          (profile) =>
            profile.profileId === source.profile.profileId &&
            profile.generation === source.profile.generation,
        )
      )
        continue;
      if (this.online.get(id) !== source) continue;
      this.online.delete(id);
      for (const state of this.states.values()) {
        if (state.sourceServerId !== id || state.state !== "online") continue;
        const current = snapshot.profiles.find(
          (profile) =>
            profile.profileId === state.profileId && profile.generation === state.generation,
        );
        if (current) this.setState(current, "offline");
      }
      void this.releaseSource(source).catch(() => undefined);
    }
    for (const [id, state] of this.states) {
      if (
        !snapshot.profiles.some(
          (profile) => profile.profileId === id && profile.generation === state.generation,
        )
      )
        this.states.delete(id);
    }
    this.changes.fire();
  }

  async disconnect(sourceServerId: string): Promise<void> {
    const source = this.online.get(sourceServerId);
    if (!source) return;
    this.online.delete(sourceServerId);
    await this.releaseSource(source);
    for (const state of this.states.values()) {
      if (state.sourceServerId === sourceServerId)
        this.setState(
          { ...source.profile, profileId: state.profileId, generation: state.generation },
          "offline",
        );
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.directorySubscription.dispose();
    const pending = [...this.activeFlights];
    for (const flight of pending) flight.controller.abort();
    this.flights.clear();
    await this.directoryBootstrap;
    await Promise.allSettled(pending.map((flight) => flight.promise));
    await Promise.allSettled(
      Array.from(this.online.values(), (source) => this.releaseSource(source)),
    );
    this.online.clear();
    this.changes.dispose();
  }
}
