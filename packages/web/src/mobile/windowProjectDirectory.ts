import type { IChannelClient } from "@zcode/rpc";
import type { RemoteServiceAccess } from "@zcode/client";

/** 手机只准备窗口目录能力，真实目录由共享 Root 的同一 ProjectDirectoryProvider 读取。 */
export async function prepareMobileWindowProjectDirectory(
  accessor: RemoteServiceAccess,
  client: IChannelClient,
  advertisedVersion: number | undefined,
  assertCurrent: () => void,
): Promise<void> {
  if (advertisedVersion === undefined) return;
  if (advertisedVersion !== 1) throw new Error("Unsupported window directory capability");
  // 原因：旧 facade 把 filesystem readDirectory 的 {path,entries} 当成窗口 tab snapshot。
  // 修复依据：共享目录已有 tree/remote owner；这里只装配同一 accessor 的整组代理，不再另建投影。
  const services = accessor.attachWindowProjectDirectory(client);
  // Initialize 可以早于 ready；这里只向已有 client 加代理，不能替换 reader 或 ACK 序号。
  const capability = await services.changesService.getCapabilities();
  assertCurrent();
  if (capability.version !== 1) throw new Error("Unsupported window directory capability");
}
