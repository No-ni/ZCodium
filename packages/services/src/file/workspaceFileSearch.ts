import { setImmediate } from "node:timers/promises";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  createWorkspaceFileSearchCandidateSelector,
  mapWorkspaceFileEntriesToSearchCandidates,
  type WorkspaceFileSearchCandidate,
} from "@zcode/shared/workspaceFileSearch";

/** 分批解码已有 packed 索引，防止把 Renderer 的长任务简单搬到共享 Host。 */
export async function buildHostFileSearchCandidates(packed: string, rootPath: string) {
  const candidates: WorkspaceFileSearchCandidate[] = [];
  for (let offset = 0; offset < packed.length; ) {
    const newline = packed.indexOf("\n", offset + 128_000);
    const end = newline < 0 ? packed.length : newline + 1;
    const entries = unpackWorkspaceFileEntries(packed.slice(offset, end), rootPath);
    for (const candidate of mapWorkspaceFileEntriesToSearchCandidates(entries))
      candidates.push(candidate);
    offset = end;
    await setImmediate();
  }
  return candidates;
}

const HOST_FILE_SEARCH_BATCH_SIZE = 2048;

export async function searchHostFileCandidates(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  limit: number,
): Promise<WorkspaceFileEntry[]> {
  const selector = createWorkspaceFileSearchCandidateSelector(query, { limit });
  // 每批只评分新候选，旧 top-K 的分数和全局索引由单次 selector 保留。
  for (let offset = 0; offset < candidates.length; offset += HOST_FILE_SEARCH_BATCH_SIZE) {
    selector.append(candidates.slice(offset, offset + HOST_FILE_SEARCH_BATCH_SIZE));
    await setImmediate();
  }
  return selector
    .getMatches()
    .map(({ name, path, relativePath, type }) => ({ name, path, relativePath, type }));
}
