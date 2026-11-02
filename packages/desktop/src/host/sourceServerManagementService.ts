import { Emitter } from "@zcode/rpc";
import {
  connectionProfileSchema,
  sourceServerDisconnectSchema,
  sourceServerIdentityConfirmationSchema,
  sourceServerManagementSnapshotSchema,
  sourceServerProfileOperationSchema,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";
import { SourceServerDirectory } from "./sourceServerDirectory.js";
import { SourceServerConnectionManager } from "./sourceServerConnectionManager.js";

export function createSourceServerManagementService(options: {
  directory: SourceServerDirectory;
  manager: SourceServerConnectionManager;
}): ISourceServerManagementService & { dispose(): void } {
  const changes = new Emitter<void>();
  const directorySubscription = options.directory.onDidChange(() => changes.fire());
  const managerSubscription = options.manager.onDidChange(() => changes.fire());
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Source management is closed");
  };
  const snapshot = async (): Promise<SourceServerManagementSnapshot> => {
    assertOpen();
    const directory = await options.directory.snapshot();
    assertOpen();
    return sourceServerManagementSnapshotSchema.parse({
      directory,
      states: options.manager.listStates(),
    });
  };
  const connect = async (raw: unknown, confirmation: boolean) => {
    assertOpen();
    const input = confirmation
      ? sourceServerIdentityConfirmationSchema.parse(raw)
      : sourceServerProfileOperationSchema.parse(raw);
    const profile = await options.directory.assertCurrent(input);
    const target = await options.directory.resolveTarget(profile);
    assertOpen();
    const expectedId =
      "expectedSourceServerId" in input && typeof input.expectedSourceServerId === "string"
        ? input.expectedSourceServerId
        : undefined;
    if (expectedId) {
      const pending = options.manager
        .listStates()
        .find((state) => state.profileId === input.profileId);
      if (
        pending?.state !== "identity-change-pending" ||
        pending.generation !== input.generation ||
        pending.pendingSourceServerId !== expectedId
      ) {
        throw new Error("Source identity confirmation is stale");
      }
    }
    // 显式连接仅发布物理服务；workspace 的配置同步仍由既有 attachment 屏障接纳。
    const handle = await options.manager.retain(profile, target, undefined, expectedId);
    await handle.dispose();
    return snapshot();
  };
  const sourceTarget = async (sourceServerId: string) => {
    assertOpen();
    sourceServerDisconnectSchema.parse({ sourceServerId });
    const directory = await options.directory.snapshot();
    const server = directory.servers.find(
      (candidate) => candidate.sourceServerId === sourceServerId,
    );
    const profile = directory.profiles.find(
      (candidate) =>
        candidate.sourceServerId === sourceServerId &&
        (!server?.preferredProfileId || candidate.profileId === server.preferredProfileId),
    );
    if (!profile) throw new Error("Source has no selected connection Profile");
    const target = await options.directory.resolveTarget(profile);
    assertOpen();
    return { profile, target };
  };
  return {
    onDidChange: changes.event,
    async getCapabilities() {
      assertOpen();
      return { version: 1 };
    },
    getSnapshot: snapshot,
    async saveProfile(raw) {
      assertOpen();
      await options.directory.saveProfile(connectionProfileSchema.parse(raw));
      return snapshot();
    },
    async removeProfile(raw) {
      assertOpen();
      const input = sourceServerProfileOperationSchema.parse(raw);
      await options.directory.removeProfile(input.profileId, input.generation);
      return snapshot();
    },
    connectProfile: (raw) => connect(raw, false),
    confirmIdentityChange: (raw) => connect(raw, true),
    async disconnectSource(raw) {
      assertOpen();
      const input = sourceServerDisconnectSchema.parse(raw);
      await options.manager.disconnect(input.sourceServerId);
      return snapshot();
    },
    async stopSource(sourceServerId) {
      const { profile, target } = await sourceTarget(sourceServerId);
      await options.manager.stopSource(profile, target);
      return snapshot();
    },
    async restartSource(sourceServerId) {
      const { profile, target } = await sourceTarget(sourceServerId);
      await options.manager.restartSource(profile, target);
      return snapshot();
    },
    async getSourceRunningTasks(sourceServerId) {
      const { profile, target } = await sourceTarget(sourceServerId);
      return options.manager.getRunningTasks(profile, target);
    },
    dispose() {
      if (closed) return;
      closed = true;
      directorySubscription.dispose();
      managerSubscription.dispose();
      changes.dispose();
    },
  };
}
