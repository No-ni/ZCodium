import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import type { NativeContextSqliteRepository } from "./contract.js";

/** Runtime 提供完整候选；storage 只比较真实分支和原 revision，不合并配置。 */
export function commitExampleNativeContextState(
  store: NativeContextSqliteRepository,
  sessionId: string,
  candidate: NativeContextStoredState,
): void {
  const previous = store.getState(sessionId);
  store.commit(sessionId, {
    expectedRevision: previous?.revision ?? null,
    expectedGeneration: candidate.generation,
    state: { ...candidate, revision: previous ? previous.revision + 1 : 0 },
  });
}
