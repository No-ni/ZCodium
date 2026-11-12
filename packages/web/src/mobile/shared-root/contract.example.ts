import type { MobileSharedRootTransport } from "./contract.js";

/** 只示例当前窗口已准入的 workspace；scope 失效后不能继续使用借来的代理。 */
export async function currentMobileWorkspace(client: MobileSharedRootTransport) {
  const access = await client.openSharedWorkspace({ workspaceKey: "existing-workspace" });
  if (!access.isCurrent()) throw new Error("mobile-workspace-superseded");
  return access.descriptor;
}
