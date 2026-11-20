import type { SessionEvent } from "@zcode/contracts";
import { deriveLocalGenerationFact } from "./contract.js";

export function observeExample(event: SessionEvent) {
  return deriveLocalGenerationFact("runtime-instance", String(event.sessionId), event);
}
