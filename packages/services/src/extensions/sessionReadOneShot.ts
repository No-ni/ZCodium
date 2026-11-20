import {
  ExtensionError,
  type SessionInteractionsEvent,
  type SessionTargetInput,
} from "@zcode/shared/extension-host";
import type { CapabilityCallContext } from "./capabilityTypes.js";
import type { Registration, SessionInteractionsRead } from "./sessionReadTypes.js";
type AdmitRegistration = (
  call: CapabilityCallContext,
  input: SessionTargetInput,
  kind: Registration["kind"],
  capabilityId: string,
  listener: (event: never) => void,
  fail: (error: ExtensionError) => void,
  oneShot?: boolean,
) => Registration | null;
// 单次读取沿用原登记与release，同步拒绝及迟到结果均由原owner收口。
export function readOneShotInteractions(
  call: CapabilityCallContext,
  sessionId: string,
  admitRegistration: AdmitRegistration,
  release: (registration: Registration) => void,
): Promise<SessionInteractionsRead> {
  // 临时挂一个交互登记：第一个事件就是当前值（镜像已有快照时立刻到，没有时等首个快照），拿到就释放。
  return new Promise<SessionInteractionsRead>((resolveRead, rejectRead) => {
    let settled = false;
    let registration: Registration | null = null;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      if (registration) release(registration);
      outcome();
    };
    registration = admitRegistration(
      call,
      { sessionId },
      "interactions",
      "sessions.resolveInteraction",
      ((event: SessionInteractionsEvent) => {
        const target = registration?.mirror?.target;
        finish(() =>
          target
            ? resolveRead({ target: { ...target }, event })
            : rejectRead(new ExtensionError("unavailable", "the session is not available to read")),
        );
      }) as (event: never) => void,
      (error) => finish(() => rejectRead(error)),
      true,
    );
    // 登记时同步失败（上限）：fail 已经结束了这次读取；镜像已有快照时首个事件也是同步到达的。
    if (settled && registration) release(registration);
  });
}
