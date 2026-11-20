import type { ICredentialService } from "./contract.js";
/** 用户凭据调用者只能使用服务契约，不能指定真实存储路径。 */
export async function inspectExample(service: ICredentialService): Promise<boolean> {
  return (await service.inspectStore()).status === "healthy";
}
