/**
 * cli-usage-projection 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { SessionEvent } from "@zcode/contracts";
import { firstModelTokenAt } from "./contract.js";

export function exampleCliUsageProjection(events: readonly SessionEvent[]): number | undefined {
  return firstModelTokenAt(events, 0);
}
