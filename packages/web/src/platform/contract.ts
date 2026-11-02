import type { IPlatformService, WebRemoteControlPlatformMethod } from "@zcode/shared";

/** 白名单方法的参数元组：直接从 IPlatformService 对应成员推导，不在 web 包复制第二份映射。 */
type PlatformMethodArgs<K extends WebRemoteControlPlatformMethod> =
  NonNullable<IPlatformService[K]> extends (...args: infer Args) => unknown ? Args : never;

/** 白名单方法的返回值：同样来自 IPlatformService 真实合同。 */
type PlatformMethodResult<K extends WebRemoteControlPlatformMethod> =
  NonNullable<IPlatformService[K]> extends (...args: never[]) => infer Result
    ? Awaited<Result>
    : never;

/**
 * 手机远控平台代理：requestPlatformMethod 只允许调用 shared webRemoteControl 信封白名单内的
 * 平台方法，参数与返回值由 IPlatformService 真实合同推导，shared 之外的 web 包不复制映射。
 * 上游官方的遥测事件上报与账号/OAuth 状态端口已按本 fork 审计边界退休，shared 不再导出对应
 * 符号，这里也不恢复。
 */
export interface WebRemoteControlPlatformProxy {
  requestPlatformMethod<K extends WebRemoteControlPlatformMethod>(
    method: K,
    ...args: PlatformMethodArgs<K>
  ): Promise<PlatformMethodResult<K>>;
}
