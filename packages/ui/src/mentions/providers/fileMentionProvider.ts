import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import type { FileReferenceRoot } from "@/lib/fileReferenceRoot.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { getMentionGroupLimitForQuery } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";

export function isLocalWorkspaceForFileMentionIndex(workspaceIdentity?: string): boolean {
  return !workspaceIdentity?.trim();
}

type ProjectFileEntry = WorkspaceFileEntry & {
  rootPath?: string;
  rootName?: string;
  mentionPath?: string;
};

/**
 * 文件候选 → 提及条目。
 *
 * `rootResolved = false`（搜索根是回落值、接收方会话的执行 cwd 未知：草稿预热未就绪 / 首帧身份
 * 不匹配）时按**绝对路径**生成提及：此时 `relativePath` 是相对工作区键路径的，会被首发会话按
 * 它自己新铸的执行目录解析而找不到文件。判据与理由见 `FileReferenceRoot` 与 spec 已知边界 14。
 * 额外 root 的候选在 `read()` 里已被标成绝对 `mentionPath`，因此不受这个开关影响，始终是绝对路径。
 */
export function mapWorkspaceFileToMentionItem(
  entry: ProjectFileEntry,
  rootResolved: boolean,
): MentionItem {
  const mentionPath = rootResolved ? (entry.mentionPath ?? entry.relativePath) : entry.path;
  return {
    id: `file:${entry.path}`,
    category: "files",
    label: entry.name,
    description: entry.relativePath,
    value: mentionPath,
    // Bugfix: 文件 mention 的标准转译格式需要保持 `[filename](path)`，
    // 之前这里误把整条 relativePath 当成链接文本，导致发送后回显和复制内容都退化成“长路径做标题”。
    // 这里恢复为只用 basename 做 label，路径只放在链接目标里，和输入框 node 样式保持一致。
    markdown: buildFileMentionMarkdown(mentionPath, entry.name, entry.type),
    keywords: [entry.relativePath, entry.path],
    data: {
      kind: entry.type,
      path: entry.path,
      // 与 value/markdown 同源：序列化层按 data.relativePath 重建链接目标，
      // 这里留相对路径会让「未证明的搜索根」在 chip→markdown 往返后又变回找不到的相对引用。
      relativePath: mentionPath,
      rootName: entry.rootName,
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
  context?: { sessionId?: string | null; projectId?: string | null },
): MentionCategoryResult {
  // 连接与身份解析按 tab 的工作区根走：`ignoreRulesRoot` 就是 tab 的 workspacePath，
  // 而 `searchRoot.rootPath` 可能只是某个会话的执行 cwd（另一个目录），拿它解析服务
  // 等于把会话目录当成 workspace 身份，路由与任务归属都会查错 Host。
  const { services } = useWorkspaceServicesResolution(
    ignoreRulesRoot,
    undefined,
    workspaceIdentity,
  );
  const { fileService } = services;
  // 项目服务面已从 accessor 退休：只经 windowProjectDirectory 取，
  // 旧 server wire / 测试 double 可以不提供，缺它时 readRoots 显式报不可用。
  const projectService = services.windowProjectDirectory?.projectService;
  const { resolved: searchRootResolved, rootPath: searchRootPath } = searchRoot;
  const sessionId = context?.sessionId;
  const projectId = context?.projectId;
  const [projectRevision, setProjectRevision] = useState(0);
  useEffect(() => {
    const subscription = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") setProjectRevision((value) => value + 1);
    });
    return () => subscription.dispose();
  }, [services]);
  const limit =
    getMentionGroupLimitForQuery(query, defaultPreviewLimit) ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  // 连接实例也属于作用域：相同路径的远程重连不能接纳旧 Host 的查询结果。
  const scope = useMemo(
    () => ({
      error: null as Error | null,
      lastMissQuery: null as string | null,
    }),
    [
      fileService,
      projectService,
      searchRootPath,
      searchRootResolved,
      ignoreRulesRoot,
      workspaceIdentity,
      enabled,
      sessionId,
      projectId,
      projectRevision,
    ],
  );
  const [result, setResult] = useState<{
    scope: typeof scope;
    query: string;
    limit: number;
    entries: ProjectFileEntry[];
    loading: boolean;
    error: Error | null;
  } | null>(null);

  useEffect(() => {
    // 错误态等待面板/工作区/连接生命周期重置，避免 query 变化触发失败重试循环。
    if (!enabled || scope.error) return;
    let active = true;
    setResult({ scope, query, limit, entries: [], loading: true, error: null });
    const readRoots = async () => {
      if ((sessionId || projectId) && !projectService)
        throw new Error("project.service-unavailable");
      if (sessionId)
        return (
          await projectService!.resolveSessionDirectories({
            taskId: sessionId,
            // 任务归属按工作区身份根（tab 的 workspacePath）查：库里的 task 行以对话根为
            // workspacePath，按会话执行 cwd 查不到任何项目绑定，additionalDirectories 会空。
            workspacePath: ignoreRulesRoot,
            workspaceIdentity,
          })
        ).additionalDirectories;
      if (projectId) {
        const project = (await projectService!.readProjects()).find(
          (project) => project.id === projectId,
        );
        if (!project) throw new Error("project.not-found");
        return project.roots.map((root) => root.rootPath);
      }
      return [];
    };
    const read = async (refresh = false): Promise<ProjectFileEntry[]> => {
      // 主根是本次文件搜索根（会话执行 cwd，未证明时是回落的工作区根），额外目录来自
      // 项目绑定；顺序固定，主根永远第一个，去重按路径字符串。
      const roots = [...new Set([searchRootPath, ...(await readRoots())])];
      if (!active) return [];
      const results = await Promise.all(
        roots.map(async (rootPath) =>
          // 忽略规则根每个请求都要带：规则只有一份、落在对话根上，会话目录里不生成
          // `.zcodiumignore`（spec 规则 10）；缺省等于 rootPath 时会去会话目录找规则。
          (
            await fileService.searchWorkspaceFiles({
              rootPath,
              ignoreRulesRoot,
              workspaceIdentity,
              query,
              limit,
              ...(refresh ? { refresh: true } : {}),
            })
          ).map((entry) => ({
            ...entry,
            rootPath,
            rootName: rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? rootPath,
            // 主根候选保留相对路径（由 searchRootResolved 决定最终是否升级成绝对路径）；
            // 额外 root 的候选一律绝对路径，否则同名相对路径会被接收方按自己的 cwd
            // 解析到另一个项目 root 的文件上。
            mentionPath: rootPath === searchRootPath ? entry.relativePath : entry.path,
          })),
        ),
      );
      const unique = new Map<string, ProjectFileEntry>();
      for (const entry of results.flat())
        if (!unique.has(entry.path)) unique.set(entry.path, entry);
      return [...unique.values()].slice(0, limit);
    };
    const search = async () => {
      try {
        let entries = await read();
        if (!active) return;
        const normalizedQuery = normalizeRefreshQuery(query);
        if (entries.length === 0 && normalizedQuery && scope.lastMissQuery !== normalizedQuery) {
          scope.lastMissQuery = normalizedQuery;
          // 无命中补扫必须绕过 Host TTL，否则外部新文件在缓存有效期内永远不可见。
          entries = await read(true);
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
    projectService,
    searchRootPath,
    searchRootResolved,
    ignoreRulesRoot,
    workspaceIdentity,
    sessionId,
    projectId,
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
