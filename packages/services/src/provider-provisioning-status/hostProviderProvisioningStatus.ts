import { randomUUID } from "node:crypto";
import {
  HostMessageTypes,
  HostResponseTypes,
  type ProviderProvisioningLaneStatus,
} from "@zcode/shared";
import type { IProviderProvisioningStatusService } from "./contract.js";

type LaneAction = "read" | "wait" | "retry";

export interface LaneResultMessage {
  readonly type: typeof HostMessageTypes.ProviderProvisioningLaneResult;
  readonly requestId: string;
  readonly status: ProviderProvisioningLaneStatus;
}

/** Host 侧装配返回面：service 注册进 ServiceCollection，handleResult 接 Main 回包，dispose 由换代/退出调用。 */
export interface HostProviderProvisioningStatus {
  service: IProviderProvisioningStatusService;
  /** 返回 false 表示该回包不属于本 lane（requestId 未知或已清理），调用方继续走其它分发。 */
  handleResult(message: LaneResultMessage): boolean;
  /** 拒绝全部在飞请求并停止接受新请求；Host replace / dispose 必须调用，否则 Renderer 的 RPC 永远悬挂。 */
  dispose(reason?: unknown): void;
}

/**
 * 本机 Host 到 Main 协调器的 Provisioning lane 访问。
 *
 * ```text
 * Renderer ─RPC─▶ service.getStatus / retry ─▶ HostResponse lane-request {requestId, action} ─▶ Main 协调器
 *                                   ◀─ handleResult ◀─ HostMessage lane-result {requestId, status} ◀─┘
 * ```
 *
 * Main 对每个请求都应答（无协调器时回「无 lane」），这里不设超时掩盖同步问题；Host 换代或退出时
 * 由 dispose() 显式拒绝在飞请求，而不是等进程消失留下永不 resolve 的 Promise。
 *
 * requestId 用 crypto.randomUUID：同一毫秒内的换代/重试都可能产生 `Date.now()+sequence` 碰撞，
 * 一旦新旧实例并存，旧实例的迟到结果会命中新实例的 pending 并把错误的 lane 状态当成答案。
 */
export function createHostProviderProvisioningStatus(
  postMessage: (message: unknown) => void,
): HostProviderProvisioningStatus {
  const pending = new Map<
    string,
    {
      resolve: (status: ProviderProvisioningLaneStatus) => void;
      reject: (error: unknown) => void;
    }
  >();
  let sequence = 0;
  let disposed: { reason: unknown } | null = null;

  const request = (
    action: LaneAction,
    sourceServerId: string,
  ): Promise<ProviderProvisioningLaneStatus> => {
    // 换代后旧实例不再接受请求：立即失败，避免向 Main 发出无人回收的 lane-request。
    if (disposed) {
      return Promise.reject(
        Object.assign(new Error("Provider provisioning status lane is disposed"), {
          code: "disposed",
        }),
      );
    }
    // 保留 sequence 仅用于日志可读性；身份唯一性完全由 UUID 承担。
    sequence += 1;
    const requestId = `provider-provisioning-lane-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try {
        postMessage({
          type: HostResponseTypes.ProviderProvisioningLaneRequest,
          requestId,
          sourceServerId,
          action,
        });
      } catch (error) {
        pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  return {
    service: {
      getStatus: (params) => request(params.waitForIdle ? "wait" : "read", params.sourceServerId),
      retry: (params) => request("retry", params.sourceServerId),
    },
    handleResult(message) {
      const entry = pending.get(message.requestId);
      if (!entry) return false;
      pending.delete(message.requestId);
      entry.resolve(message.status);
      return true;
    },
    dispose(reason) {
      if (disposed) return;
      disposed = { reason };
      const error = Object.assign(new Error("Provider provisioning status lane is disposed"), {
        code: "disposed",
      });
      for (const [, entry] of pending) entry.reject(error);
      pending.clear();
    },
  };
}
