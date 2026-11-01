import type { WorkspaceFileEntry } from "@zcode/shared";

/**
 * Safety-net cap for virtualized display. Large enough to never feel
 * "incomplete" to users, small enough to keep fuzzy-sort and virtualizer
 * memory in check for enormous monorepos.
 */
export const WORKSPACE_FILE_SEARCH_DISPLAY_CAP = 1000;

export interface WorkspaceFileSearchCandidate {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  type: WorkspaceFileEntry["type"];
  /**
   * 预计算的小写形式：打分热路径不再对每条候选反复 toLowerCase。
   * 放开 node_modules 后候选基数可达数十万，
   * 每键 3-4 次全串 toLowerCase 是卡顿主因之一；索引构建时一次性归一化。
   */
  lowercaseName: string;
  lowercaseRelativePath: string;
  lowercasePath: string;
}

export interface FilterWorkspaceFileSearchCandidatesOptions {
  limit?: number;
  requireQuery?: boolean;
}

export function hasWorkspaceFileSearchQuery(query: string): boolean {
  return query.trim().length > 0;
}

export function mapWorkspaceFileEntriesToSearchCandidates(
  entries: WorkspaceFileEntry[],
): WorkspaceFileSearchCandidate[] {
  return entries.map((entry) => {
    // trim 与原打分函数的归一化保持一致（防御首尾空格文件名），严格行为等价。
    const lowercaseRelativePath = entry.relativePath.trim().toLowerCase();
    return {
      id: entry.relativePath,
      name: entry.name,
      path: entry.path,
      relativePath: entry.relativePath,
      type: entry.type,
      lowercaseName: entry.name.trim().toLowerCase(),
      lowercaseRelativePath,
      lowercasePath: entry.path.trim().toLowerCase(),
    };
  });
}

export function scoreWorkspaceFileFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedText) {
    return null;
  }

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

/** scoreWorkspaceFileFuzzyMatch 的热路径版本：text/query 均为已归一化（trim+lower）输入。 */
function scoreNormalizedFuzzyMatch(normalizedText: string, normalizedQuery: string): number | null {
  if (!normalizedText) {
    return null;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

export function getWorkspaceFileSearchCandidateScore(
  candidate: WorkspaceFileSearchCandidate,
  query: string,
): number | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const nameScore = scoreNormalizedFuzzyMatch(candidate.lowercaseName, normalizedQuery);
  const relativePathScore = scoreNormalizedFuzzyMatch(
    candidate.lowercaseRelativePath,
    normalizedQuery,
  );
  const pathScore = scoreNormalizedFuzzyMatch(candidate.lowercasePath, normalizedQuery);
  // relativePath 打分只计 +25 档；更高的 +100 档恒被同一打分的 +25 项压制，属于死代码；
  // keywords 项（+300）保留，覆盖"query 跨目录段子序列命中"的场景。
  const keywordScore = Math.min(
    relativePathScore !== null ? relativePathScore + 300 : Number.POSITIVE_INFINITY,
    pathScore !== null ? pathScore + 300 : Number.POSITIVE_INFINITY,
  );
  const bestScore = Math.min(
    nameScore ?? Number.POSITIVE_INFINITY,
    relativePathScore !== null ? relativePathScore + 25 : Number.POSITIVE_INFINITY,
    keywordScore,
  );

  return Number.isFinite(bestScore) ? bestScore : null;
}

function applyWorkspaceFileSearchLimit<T>(items: T[], limit?: number): T[] {
  if (!Number.isFinite(limit)) {
    return items;
  }

  const safeLimit = Math.max(0, Math.trunc(limit ?? 0));
  return items.slice(0, safeLimit);
}

function getDefaultWorkspaceFileSearchPriority(candidate: WorkspaceFileSearchCandidate): number {
  return candidate.type === "directory" ? 1 : 0;
}

function sortDefaultWorkspaceFileSearchCandidates(
  candidates: WorkspaceFileSearchCandidate[],
): WorkspaceFileSearchCandidate[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      priority: getDefaultWorkspaceFileSearchPriority(candidate),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ candidate }) => candidate);
}

interface ScoredWorkspaceFileSearchCandidate {
  candidate: WorkspaceFileSearchCandidate;
  index: number;
  score: number;
}

function compareScoredWorkspaceFileSearchCandidates(
  left: ScoredWorkspaceFileSearchCandidate,
  right: ScoredWorkspaceFileSearchCandidate,
): number {
  if (left.score !== right.score) {
    return left.score - right.score;
  }
  if (left.index !== right.index) {
    return left.index - right.index;
  }
  return left.candidate.name.localeCompare(right.candidate.name);
}

/**
 * 大 workspace（数万候选）下 top-K 插入点曾用 findIndex 线性扫，最坏
 * O(候选数 × limit)（65k 候选 × 1000 ≈ 6500 万次比较，实测单键 155ms 同步阻塞
 * 主线程，@ 面板键入时整窗冻结）。compareScoredWorkspaceFileSearchCandidates 按
 * (score, index) 严格全序（index 单次遍历内唯一），二分查找插入点安全，
 * 单次过滤降到 O(n log K)。
 */
function findInsertionIndexByBinarySearch(
  bestMatches: ScoredWorkspaceFileSearchCandidate[],
  scored: ScoredWorkspaceFileSearchCandidate,
): number {
  let low = 0;
  let high = bestMatches.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const midItem = bestMatches[mid];
    if (midItem !== undefined && compareScoredWorkspaceFileSearchCandidates(scored, midItem) < 0) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low === bestMatches.length ? -1 : low;
}

/** 单次查询的派生 top-K owner：跨批保留分数，不重算已入选候选。 */
export interface WorkspaceFileSearchCandidateSelector {
  append(candidates: readonly WorkspaceFileSearchCandidate[]): void;
  getMatches(): WorkspaceFileSearchCandidate[];
}

export function createWorkspaceFileSearchCandidateSelector(
  query: string,
  options: FilterWorkspaceFileSearchCandidatesOptions = {},
): WorkspaceFileSearchCandidateSelector {
  const effectiveLimit = options.limit ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  const normalizedQuery = query.trim();
  const requireQuery = options.requireQuery;
  const bestMatches: ScoredWorkspaceFileSearchCandidate[] = [];
  let defaultMatches: WorkspaceFileSearchCandidate[] = [];
  let nextIndex = 0;

  return {
    append(candidates) {
      if (!normalizedQuery) {
        if (!requireQuery) {
          defaultMatches = applyWorkspaceFileSearchLimit(
            sortDefaultWorkspaceFileSearchCandidates([...defaultMatches, ...candidates]),
            effectiveLimit,
          );
        }
        return;
      }

      for (const candidate of candidates) {
        // 旧 Host 每批将 best 拼回输入，已入选候选会反复打分；这里只处理新批次，
        // 保留全局原始 index，确保跨批同分仍按原输入顺序，而不是按当前排名重编号。
        const index = nextIndex++;
        const score = getWorkspaceFileSearchCandidateScore(candidate, normalizedQuery);
        if (score === null) continue;

        const scored = { candidate, index, score };
        const worst = bestMatches[bestMatches.length - 1];
        if (
          worst !== undefined &&
          bestMatches.length >= effectiveLimit &&
          compareScoredWorkspaceFileSearchCandidates(scored, worst) >= 0
        ) {
          continue;
        }

        const insertionIndex = findInsertionIndexByBinarySearch(bestMatches, scored);
        if (insertionIndex === -1) {
          if (bestMatches.length < effectiveLimit) bestMatches.push(scored);
          continue;
        }

        bestMatches.splice(insertionIndex, 0, scored);
        if (bestMatches.length > effectiveLimit) bestMatches.pop();
      }
    },
    getMatches() {
      return normalizedQuery
        ? bestMatches.map(({ candidate }) => candidate)
        : defaultMatches.slice();
    },
  };
}

export function filterWorkspaceFileSearchCandidates(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  options: FilterWorkspaceFileSearchCandidatesOptions = {},
): WorkspaceFileSearchCandidate[] {
  const selector = createWorkspaceFileSearchCandidateSelector(query, options);
  selector.append(candidates);
  return selector.getMatches();
}
