import type { AgentRuntimeInternal } from "../internal.js";
import { readApprovedPlanFileReferenceEntry } from "../helpers/plan-file-continuity.js";
import { workspaceScopeRootOf } from "../helpers/workspace-scope.js";
import { nativeReadOwner, ownedNativeSourceText } from "./read.js";
import { kernelOf } from "./state.js";
import { NativeContextRuntimeError } from "./contract.js";

/** 关键词必须命中；计划只加排序权重。逐来源 IO 有界且服从工具的停止信号。 */
export async function searchNativeContext(
  runtime: AgentRuntimeInternal,
  input: { query: string; maxHits?: number },
  signal?: AbortSignal,
) {
  const owner = await nativeReadOwner(runtime),
    state = owner.state!,
    revision = state.revision;
  const parameters = state.policy.parameters.retrieval;
  const terms = [...new Set(input.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean))];
  const planEntry =
    parameters.planAware && runtime.fileSystemPort
      ? await readApprovedPlanFileReferenceEntry({
          fileSystemPort: runtime.fileSystemPort,
          sessionId: runtime.sessionId,
          workspaceRoot: runtime.workspaceRoot,
          workspaceKeyRoot: workspaceScopeRootOf(runtime),
          abortSignal: signal,
          traceContext: runtime.rootTraceContext,
        })
      : undefined;
  const planTerms =
    planEntry?.kind === "attachment"
      ? [
          ...new Set(
            planEntry.content
              .toLocaleLowerCase()
              .split(/\s+/u)
              .filter((term) => term.length > 2),
          ),
        ].slice(0, 128)
      : [];
  const limit = Math.min(input.maxHits ?? parameters.maxHits, parameters.maxHits);
  const sources = state.sources.filter((source) => source.kind !== "image");
  const selected = sources.slice(-1000).reverse();
  const results: { ref: string; score: number; preview: string; kind: string }[] = [];
  let scannedChars = 0,
    scannedSources = 0;
  const check = () => {
    if (signal?.aborted) throw signal.reason;
    if (owner.state!.revision !== revision || owner.state!.generation !== runtime.branchGeneration)
      throw new NativeContextRuntimeError("stale-view", "revision");
  };
  const inspect = (ref: string, text: string, kind: string) => {
    const lower = text.toLocaleLowerCase(),
      queryMatches = terms.filter((term) => lower.includes(term));
    if (!queryMatches.length) return;
    const score =
      queryMatches.length * 100 + planTerms.filter((term) => lower.includes(term)).length;
    const offset = Math.max(0, lower.indexOf(queryMatches[0]!) - 80);
    results.push({ ref, score, preview: text.slice(offset, offset + 400), kind });
  };
  for (const source of selected) {
    check();
    if (scannedChars >= 32 * 1024 * 1024) break;
    const text = await ownedNativeSourceText(owner, source);
    check();
    scannedSources++;
    if (text === null) continue;
    scannedChars += text.length;
    inspect(source.ref, text, source.kind);
  }
  for (const block of kernelOf(state).compression.blocks.slice(-1000)) {
    check();
    inspect(block.blockId, block.summary, "summary");
  }
  results.sort((left, right) => right.score - left.score);
  const bounded: typeof results = [];
  let outputChars = 0;
  for (const result of results.slice(0, limit)) {
    const size = JSON.stringify(result).length;
    if (outputChars + size > 80_000) break;
    bounded.push(result);
    outputChars += size;
  }
  return {
    results: bounded,
    truncated: bounded.length < results.length || scannedSources < sources.length,
    searchedSources: scannedSources,
    totalSources: sources.length,
  };
}
