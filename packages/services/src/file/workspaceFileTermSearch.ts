import { setImmediate } from "node:timers/promises";
import type { WorkspaceFileEntry } from "@zcode/shared";
import type { WorkspaceFileSearchCandidate } from "@zcode/shared/workspaceFileSearch";

const normalizedIndexes = new WeakMap<WorkspaceFileSearchCandidate[], string[]>();
const SEARCH_BATCH_SIZE = 2048;

export async function searchWorkspaceFileTerms(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  limit: number,
): Promise<WorkspaceFileEntry[]> {
  const parts = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || limit <= 0) return [];
  let normalized = normalizedIndexes.get(candidates);
  if (!normalized) {
    normalized = [];
    normalizedIndexes.set(candidates, normalized);
  }
  const results: WorkspaceFileEntry[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const entry = candidates[i]!;
    if (entry.type === "file") {
      // 旧命令中心每键都在 Renderer 拼接/转小写全量索引；Host 按索引代际缓存归一化文本。
      const text = (normalized[i] ??= `${entry.name} ${entry.relativePath}`.toLocaleLowerCase());
      if (parts.every((part) => text.includes(part))) {
        const { name, path, relativePath, type } = entry;
        results.push({ name, path, relativePath, type });
        if (results.length >= limit) break;
      }
    }
    if ((i + 1) % SEARCH_BATCH_SIZE === 0) await setImmediate();
  }
  return results;
}
