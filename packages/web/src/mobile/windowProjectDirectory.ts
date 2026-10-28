import type { Event, IChannelClient } from "@zcode/rpc";
import type { RemoteServiceAccess } from "@zcode/client";
import {
  windowProjectDirectorySnapshotSchema,
  type WindowProjectDirectorySnapshot,
} from "@zcode/shared";

type DirectoryServices = NonNullable<RemoteServiceAccess["windowProjectDirectory"]>;

export class MobileWindowProjectDirectory {
  private services: DirectoryServices | undefined;

  clear(): void {
    this.services = undefined;
  }

  async prepare(
    accessor: RemoteServiceAccess,
    client: IChannelClient,
    advertisedVersion: number | undefined,
    assertCurrent: () => void,
  ): Promise<void> {
    this.clear();
    if (advertisedVersion === undefined) return;
    if (advertisedVersion !== 1) throw new Error("Unsupported window directory capability");
    const services = accessor.attachWindowProjectDirectory(client);
    // Initialize 可以早于 ready；这里只向已有 client 加代理，不能替换 reader 或 ACK 序号。
    const capability = await services.changesService.getCapabilities();
    assertCurrent();
    if (capability.version !== 1) throw new Error("Unsupported window directory capability");
    this.services = services;
  }

  async read(assertCurrent: () => void): Promise<WindowProjectDirectorySnapshot | null> {
    const services = this.services;
    if (!services) return null;
    const snapshot = windowProjectDirectorySnapshotSchema.parse(
      await services.projectService.readDirectory(),
    );
    assertCurrent();
    return snapshot;
  }

  listen(listener: () => void, isCurrent: () => boolean): ReturnType<Event<void>> {
    return (
      this.services?.changesService.onDidChange(() => {
        if (isCurrent()) listener();
      }) ?? { dispose() {} }
    );
  }
}
