import { Emitter, type Event } from "@zcode/rpc";
import {
  windowProjectDirectorySnapshotSchema,
  type WindowProjectDirectorySnapshot,
  type WindowProjectDirectoryEntry,
} from "@zcode/shared";
import type { WindowProjectDirectoryServices } from "../contract.js";

export function createWindowProjectDirectoryRuntime(
  options: {
    resolveConnectionState?: (
      entry: WindowProjectDirectoryEntry,
    ) => WindowProjectDirectoryEntry["connectionState"];
    onDidConnectionChange?: Event<void>;
  } = {},
): {
  services: WindowProjectDirectoryServices;
  accept(projection: WindowProjectDirectorySnapshot): void;
  dispose(): void;
} {
  const changes = new Emitter<void>();
  let current: WindowProjectDirectorySnapshot = { version: 1, generation: 0, workspaces: [] };
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Window directory is closed");
  };
  const connectionSubscription = options.onDidConnectionChange?.(() => {
    if (!closed) changes.fire();
  });
  const read = () =>
    structuredClone({
      ...current,
      workspaces: current.workspaces.map((entry) =>
        entry.kind === "remote" && options.resolveConnectionState
          ? { ...entry, connectionState: options.resolveConnectionState(entry) }
          : entry,
      ),
    });
  return {
    services: {
      projectService: {
        async readDirectory() {
          assertOpen();
          return read();
        },
      },
      remoteProjectService: {
        async readDirectory() {
          assertOpen();
          return {
            version: 1,
            generation: current.generation,
            entries: read().workspaces.filter((entry) => entry.kind === "remote"),
          };
        },
      },
      changesService: {
        async getCapabilities() {
          assertOpen();
          return { version: 1 };
        },
        onDidChange: changes.event,
      },
    },
    accept(projection) {
      if (closed) return;
      const parsed = windowProjectDirectorySnapshotSchema.parse(projection);
      // 旧平台消息不能覆盖新窗口投影；此处不接受目录写入或生成自己的业务成员。
      if (parsed.generation <= current.generation) return;
      current = parsed;
      changes.fire();
    },
    dispose() {
      closed = true;
      connectionSubscription?.dispose();
      changes.dispose();
    },
  };
}
