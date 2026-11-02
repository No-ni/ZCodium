import {
  sourceServerRunningTasksSchema,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerConnectionStateSnapshot,
  type SourceServerRunningTasksResult,
} from "@zcode/shared";
import type { ManagerOptions } from "./sourceServerConnectionTypes.js";

interface LifecycleFlight {
  profile: ConnectionProfile;
  operation: "stop" | "restart";
  controller: AbortController;
  promise: Promise<void>;
}

interface QueryFlight {
  profile: ConnectionProfile;
  controller: AbortController;
  promise: Promise<SourceServerRunningTasksResult>;
}

export class SourceServerOperationFlights {
  private readonly lifecycle = new Map<string, LifecycleFlight>();
  private readonly queries = new Set<QueryFlight>();

  constructor(
    private readonly options: Pick<ManagerOptions, "directory" | "executeCommand"> & {
      isClosed(): boolean;
      beforeLifecycle(profile: ConnectionProfile, signal: AbortSignal): Promise<void>;
      reconnect(
        profile: ConnectionProfile,
        target: RemoteTarget,
        signal: AbortSignal,
      ): Promise<unknown>;
      setState(
        profile: ConnectionProfile,
        state: SourceServerConnectionStateSnapshot["state"],
        errorCode?: SourceServerConnectionStateSnapshot["errorCode"],
      ): void;
    },
  ) {}

  isBusy(sourceServerId: string): boolean {
    return this.lifecycle.has(sourceServerId);
  }

  assertNotBusy(sourceServerId?: string): void {
    if (sourceServerId && this.isBusy(sourceServerId))
      throw Object.assign(new Error("Source lifecycle operation is in progress"), {
        code: "source-server-lifecycle-busy",
      });
  }

  retireProfiles(profiles: ConnectionProfile[]): void {
    for (const flight of [...this.lifecycle.values(), ...this.queries]) {
      if (
        !profiles.some(
          (profile) =>
            profile.profileId === flight.profile.profileId &&
            profile.generation === flight.profile.generation,
        )
      )
        flight.controller.abort();
    }
  }

  run(
    profile: ConnectionProfile,
    target: RemoteTarget,
    operation: "stop" | "restart",
  ): Promise<void> {
    const sourceServerId = profile.sourceServerId;
    if (!sourceServerId || this.options.isClosed())
      return Promise.reject(new Error("Source lifecycle is unavailable"));
    const existing = this.lifecycle.get(sourceServerId);
    if (existing) {
      if (
        existing.operation === operation &&
        existing.profile.profileId === profile.profileId &&
        existing.profile.generation === profile.generation
      )
        return existing.promise;
      return Promise.reject(
        Object.assign(new Error("Source lifecycle operation is in progress"), {
          code: "source-server-lifecycle-busy",
        }),
      );
    }
    const controller = new AbortController();
    const flight: LifecycleFlight = { profile, operation, controller, promise: Promise.resolve() };
    const assertLive = async () => {
      controller.signal.throwIfAborted();
      if (this.options.isClosed() || this.lifecycle.get(sourceServerId) !== flight)
        throw new Error("Source lifecycle was retired");
      await this.options.directory.assertCurrent(profile);
      controller.signal.throwIfAborted();
    };
    // 停止先占设备级 flight，避免断连与远端命令之间接入新的 attachment。
    flight.promise = Promise.resolve()
      .then(async () => {
        await assertLive();
        this.options.setState(profile, "connecting");
        const queries = [...this.queries].filter(
          (query) => query.profile.sourceServerId === sourceServerId,
        );
        for (const query of queries) query.controller.abort();
        await Promise.allSettled(queries.map((query) => query.promise));
        await this.options.beforeLifecycle(profile, controller.signal);
        await assertLive();
        const execute =
          this.options.executeCommand ??
          (await import("@zcode/server/source-server")).executeSourceServerCommand;
        await assertLive();
        const result = await execute(target, operation, { signal: controller.signal });
        await assertLive();
        if (result.code !== 0)
          throw Object.assign(new Error("Source lifecycle command failed"), {
            code: "source-server-control-failed",
          });
        if (operation === "restart") {
          await this.options.reconnect(profile, target, controller.signal);
          await assertLive();
        } else this.options.setState(profile, "offline");
      })
      .catch(async (error: unknown) => {
        if (!controller.signal.aborted && !this.options.isClosed()) {
          const current = await this.options.directory.assertCurrent(profile).catch(() => null);
          if (current) this.options.setState(current, "failed", "source-server-connection-failed");
        }
        throw error;
      })
      .finally(() => {
        if (this.lifecycle.get(sourceServerId) === flight) this.lifecycle.delete(sourceServerId);
      });
    this.lifecycle.set(sourceServerId, flight);
    return flight.promise;
  }

  getRunningTasks(
    profile: ConnectionProfile,
    target: RemoteTarget,
  ): Promise<SourceServerRunningTasksResult> {
    if (this.options.isClosed()) return Promise.reject(new Error("Source manager is closed"));
    const controller = new AbortController();
    const flight: QueryFlight = {
      profile,
      controller,
      promise: Promise.resolve({ available: false }),
    };
    flight.promise = Promise.resolve()
      .then(async (): Promise<SourceServerRunningTasksResult> => {
        this.assertNotBusy(profile.sourceServerId);
        await this.options.directory.assertCurrent(profile);
        controller.signal.throwIfAborted();
        this.assertNotBusy(profile.sourceServerId);
        const execute =
          this.options.executeCommand ??
          (await import("@zcode/server/source-server")).executeSourceServerCommand;
        controller.signal.throwIfAborted();
        const result = await execute(target, "running-tasks", { signal: controller.signal });
        controller.signal.throwIfAborted();
        await this.options.directory.assertCurrent(profile);
        if (this.options.isClosed()) throw new Error("Source manager is closed");
        if (result.code !== 0) return { available: false };
        try {
          const parsed = sourceServerRunningTasksSchema.safeParse(
            JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? ""),
          );
          return parsed.success ? { available: true, tasks: parsed.data } : { available: false };
        } catch {
          return { available: false };
        }
      })
      .finally(() => this.queries.delete(flight));
    this.queries.add(flight);
    return flight.promise;
  }

  async dispose(): Promise<void> {
    const pending = [...this.lifecycle.values(), ...this.queries];
    for (const flight of pending) flight.controller.abort();
    await Promise.allSettled(pending.map((flight) => flight.promise));
  }
}
