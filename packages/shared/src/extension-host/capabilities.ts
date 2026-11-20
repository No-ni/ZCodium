import { z } from "zod";
import { EXTENSION_ERROR_CODES, type ExtensionError } from "#src/extension-host/errors.js";
import { EXTENSION_CAPABILITIES } from "./capabilityDefinitions.js";
export { EXTENSION_CAPABILITIES } from "./capabilityDefinitions.js";

// 能力表（docs/plugins/extension-host.md §7.2）：能力的唯一定义。表里没有的能力就不存在。
// 新增一个能力只改两处：这里加一行，Window Host 的能力网关加一个处理函数。

export type { CapabilityDef } from "./capabilityDefinitions.js";
import type { CapabilityDef } from "./capabilityDefinitions.js";

/**
 * 由本地部分包装的能力：ctx 上的入口在 ExtensionLocalContext 里（先在扩展进程内校验 id 是否声明），
 * 不由能力表自动生成。
 */
export const LOCALLY_WRAPPED_CAPABILITIES = ["views.open"] as const;

export type LocallyWrappedCapabilityId = (typeof LOCALLY_WRAPPED_CAPABILITIES)[number];

export function isLocallyWrappedCapability(id: string): id is LocallyWrappedCapabilityId {
  return (LOCALLY_WRAPPED_CAPABILITIES as readonly string[]).includes(id);
}

export type ExtensionCapabilityTable = typeof EXTENSION_CAPABILITIES;

export type CapabilityId = keyof ExtensionCapabilityTable & string;

export type CapabilityInput<K extends CapabilityId> = z.input<ExtensionCapabilityTable[K]["input"]>;

export type CapabilityOutput<K extends CapabilityId> = z.output<
  ExtensionCapabilityTable[K]["output"]
>;

export function getCapabilityDef(id: string): CapabilityDef | undefined {
  return Object.hasOwn(EXTENSION_CAPABILITIES, id)
    ? (EXTENSION_CAPABILITIES as Record<string, CapabilityDef>)[id]
    : undefined;
}

export function listCapabilities(): Array<[string, CapabilityDef]> {
  return Object.entries(EXTENSION_CAPABILITIES as Record<string, CapabilityDef>);
}

// —— extension-window 频道的两个通用入口的线格式 ——

export const capabilityCallInputSchema = z.strictObject({
  pluginId: z.string().min(1),
  capabilityId: z.string().min(1),
  // 没有入参的能力传 undefined；跨 RPC 走 JSON 时这个键会消失，所以是可选的。
  input: z.unknown().optional(),
});

export type CapabilityCallInput = z.infer<typeof capabilityCallInputSchema>;

export const capabilitySubscribeInputSchema = capabilityCallInputSchema;

export type CapabilitySubscribeInput = CapabilityCallInput;

/**
 * onDynamicSubscribe 的事件信封（§17.3「订阅的错误」）：event 是能力的事件；error 结束这次订阅
 * （准入被拒、后端上限、授权撤销等），之后不再有事件。
 */
export const capabilitySubscriptionMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("event"), event: z.unknown() }),
  z.strictObject({
    kind: z.literal("error"),
    code: z.enum(EXTENSION_ERROR_CODES),
    message: z.string(),
  }),
]);

export type CapabilitySubscriptionMessage = z.infer<typeof capabilitySubscriptionMessageSchema>;

// —— ctx 能力部分的类型推导：表里加一行，ctx 的类型自动跟上 ——

export interface CapabilityDisposable {
  dispose(): void;
}

/** 订阅结束时的错误（§17.3「订阅的错误」）；之后这个监听不再收到事件。 */
export type CapabilitySubscriptionErrorListener = (error: ExtensionError) => void;

// 带入参的订阅（§17.3）生成 (input, listener, onError?) => Disposable；没有入参的是 (listener, onError?) => Disposable。
/** 带请求身份的动作：`requestId` 在 ctx 上可选，扩展进程补（§17.3 实现 P3c-1）。 */
type CallInput<D extends CapabilityDef> = D["requestIdentity"] extends true
  ? Omit<z.input<D["input"]>, "requestId"> & { requestId?: string }
  : z.input<D["input"]>;

type CapabilityMember<D extends CapabilityDef> = D["kind"] extends "call"
  ? z.input<D["input"]> extends undefined
    ? () => Promise<z.output<D["output"]>>
    : (input: CallInput<D>) => Promise<z.output<D["output"]>>
  : z.input<D["input"]> extends undefined
    ? (
        listener: (event: z.output<D["output"]>) => void,
        onError?: CapabilitySubscriptionErrorListener,
      ) => CapabilityDisposable
    : (
        input: z.input<D["input"]>,
        listener: (event: z.output<D["output"]>) => void,
        onError?: CapabilitySubscriptionErrorListener,
      ) => CapabilityDisposable;

type NamespaceOf<K extends string> = K extends `${infer NS}.${string}` ? NS : never;

type MemberOf<K extends string, NS extends string> = K extends `${NS}.${infer Name}` ? Name : never;

/** 由能力表推导出 ctx 的能力部分：`"context.get"` → `ctx.context.get`。 */
export type CapabilityContext<T extends Record<string, CapabilityDef>> = {
  readonly [NS in NamespaceOf<keyof T & string>]: {
    readonly [K in keyof T & string as MemberOf<K, NS>]: CapabilityMember<T[K]>;
  };
};

/**
 * 能力 K 在 ctx 上的入参（类型包 §17.9）：与 ctx 成员同一份推导，带请求身份的动作 `requestId` 可选。
 * 没有入参的能力为 undefined。不用 CapabilityInput：那是线上 schema 的入参，requestId 必填。
 */
export type ExtensionCapabilityInput<K extends CapabilityId> = CallInput<
  ExtensionCapabilityTable[K]
>;

/** 能力 K 在 ctx 上的返回：call 是 Promise 解出的值，subscribe 是监听收到的事件。 */
export type ExtensionCapabilityOutput<K extends CapabilityId> = z.output<
  ExtensionCapabilityTable[K]["output"]
>;
