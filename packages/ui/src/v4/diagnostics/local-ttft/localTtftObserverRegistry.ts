// local-ttft 观测器的进程内单例登记（spec：docs/monitoring/ttft-stage-telemetry.md）。
// 从 localTtftObserver.ts 末尾原样搬出：这里仍是唯一登记处，不引入第二 owner、不新增状态；
// 只以 type 引用类实现，公开入口依赖登记处，避免类型依赖图也形成循环。
import type { LocalTtftObserver } from "@/v4/diagnostics/local-ttft/localTtftObserverCore.js";

let observer: LocalTtftObserver | undefined;
export function setLocalTtftObserver(value: LocalTtftObserver | undefined): void {
  observer = value;
}
export function getLocalTtftObserver(): LocalTtftObserver | undefined {
  return observer;
}
