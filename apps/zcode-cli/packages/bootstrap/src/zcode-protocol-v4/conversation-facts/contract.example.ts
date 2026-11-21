/**
 * cli-conversation-facts 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { SessionEvent } from "@zcode/contracts";
import { runtimeTurnIdOf } from "./contract.js";

export function exampleCliConversationFacts(event: SessionEvent): string {
  return runtimeTurnIdOf(event);
}
