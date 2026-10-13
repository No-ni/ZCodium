import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import type { FileReferenceRoot } from "@/lib/fileReferenceRoot.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { getMentionGroupLimitForQuery } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";

/**
 * 文件候选 → 提及条目。
 *
 * `rootResolved = false`（搜索根是回落值、接收方会话的执行 cwd 未知：草稿预热未就绪 / 首帧身份
 * 不匹配）时按**绝对路径**生成提及：此时 `relativePath` 是相对工作区键路径的，会被首发会话按
 * 它自己新铸的执行目录解析而找不到文件。判据与理由见 `FileReferenceRoot` 与 spec 已知边界 14。
 */
export function mapWorkspaceFileToMentionItem(
  entry: WorkspaceFileEntry,
  rootResolved: boolean,
): MentionItem {
  const mentionTarget = rootResolved ? entry.relativePath : entry.path;
  return {
    id: `file:${entry.relativePath}`,
    category: "files",
    label: entry.name,
    description: entry.relativePath,
    value: mentionTarget,
    // 文件 mention 的标准转译格式需要保持 `[filename](path)`，
    // 之前这里误把整条 relativePath 当成链接文本，导致发送后回显和复制内容都退化成“长路径做标题”。
    // 这里恢复为只用 basename 做 label，路径只放在链接目标里，和输入框 node 样式保持一致。
    markdown: buildFileMentionMarkdown(mentionTarget, entry.name, entry.type),
    keywords: [entry.relativePath, entry.path],
    data: {
      kind: entry.type,
      path: entry.path,
      relativePath: mentionTarget,
    },
  };
}

function normalizeRefreshQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * `@` 文件候选来源。
 *
 * 两个路径参数必须分开：
 * - `searchRoot`：文件搜索根**及其来源**（`FileReferenceRoot`）。会话已绑定时是会话执行 cwd，
 *   否则才是 tab 的 workspacePath（见 conversation-session-workspace spec 的所有者表）；
 *   `resolved: false`（草稿预热未就绪）时候选按绝对路径插入，见
 *   `mapWorkspaceFileToMentionItem`。
 * - `ignoreRulesRoot`：忽略规则根，始终是 tab 的 workspacePath（对话会话 = 对话根）：
 *   规则只有一份、落在对话根上，绝不在会话目录里生成 `.zcodiumignore`（同 spec 规则 10）。
 *
 * `workspaceIdentity` / 连接解析不受换根影响，仍按 tab 的工作区身份走。
 */
export function useFileMentionProvider(
  searchRoot: FileReferenceRoot,
  ignoreRulesRoot: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
  defaultPreviewLimit?: number,
): MentionCategoryResult {
  const { fileService } = useServices();
  const { resolved: searchRootResolved, rootPath: searchRootPath } = searchRoot;
  const limit =
    getMentionGroupLimitForQuery(query, defaultPreviewLimit) ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  // 连接实例也属于作用域：相同路径的远程重连不能接纳旧 Host 的查询结果。
  const scope = useMemo(
    () => ({
      error: null as Error | null,
      lastMissQuery: null as string | null,
    }),
    [fileService, searchRootPath, searchRootResolved, workspaceIdentity, enabled],
  );
  const [result, setResult] = useState<{
    scope: typeof scope;
    query: string;
    limit: number;
    entries: WorkspaceFileEntry[];
    loading: boolean;
    error: Error | null;
  } | null>(null);

  useEffect(() => {
    // 错误态等待面板/工作区/连接生命周期重置，避免 query 变化触发失败重试循环。
    if (!enabled || scope.error) return;
    let active = true;
    setResult({ scope, query, limit, entries: [], loading: true, error: null });
    const params = { rootPath: searchRootPath, ignoreRulesRoot, workspaceIdentity, query, limit };
    const search = async () => {
      try {
        let entries = await fileService.searchWorkspaceFiles(params);
        if (!active) return;
        const normalizedQuery = normalizeRefreshQuery(query);
        if (entries.length === 0 && normalizedQuery && scope.lastMissQuery !== normalizedQuery) {
          scope.lastMissQuery = normalizedQuery;
          // 无命中补扫必须绕过 Host TTL，否则外部新文件在缓存有效期内永远不可见。
          entries = await fileService.searchWorkspaceFiles({ ...params, refresh: true });
          if (!active) return;
        }
        setResult({ scope, query, limit, entries, loading: false, error: null });
      } catch (error) {
        if (!active) return;
        scope.error = error instanceof Error ? error : new Error(String(error));
        setResult({ scope, query, limit, entries: [], loading: false, error: scope.error });
      }
    };
    void search();
    // 查询、工作区、连接或面板生命周期变化都使已发出的异步响应失效。
    // `ignoreRulesRoot` 也是 params 的一部分（它只决定规则从哪个根读），漏进依赖数组时
    // 闭包会停留在旧规则根：规则根变化后既不重发查询，也沿用旧规则命中的候选。
    return () => {
      active = false;
    };
  }, [
    enabled,
    fileService,
    searchRootPath,
    searchRootResolved,
    ignoreRulesRoot,
    workspaceIdentity,
    query,
    limit,
    scope,
  ]);

  const current =
    enabled && result?.scope === scope && result.query === query && result.limit === limit;
  const items = useMemo(
    () =>
      current
        ? result.entries.map((entry) => mapWorkspaceFileToMentionItem(entry, searchRootResolved))
        : [],
    [current, result, searchRootResolved],
  );
  return {
    items,
    loading: enabled && !scope.error && (!current || result.loading),
    error: enabled ? scope.error : null,
    emptyText,
    title,
  };
}
