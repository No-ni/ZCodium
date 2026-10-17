import { useEffect, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

const EMPTY_FILES: WorkspaceFileEntry[] = [];
const RESULT_LIMIT = 80;

export function filterCommandCenterFileSearchResults(
  files: WorkspaceFileEntry[],
  query: string,
): WorkspaceFileEntry[] {
  const parts = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return EMPTY_FILES;
  // 旧 Host 会忽略 matchMode 并返回 fuzzy/目录候选；只复核有界响应，不回退下载全索引。
  // 保持现代 Host 的原序；旧 Host 的漏项与排序需升级 Host 才能完全一致。
  return files.slice(0, RESULT_LIMIT).filter((file) => {
    if (file.type !== "file") return false;
    const text = `${file.name} ${file.relativePath}`.toLocaleLowerCase();
    return parts.every((part) => text.includes(part));
  });
}

export function useCommandCenterFileSearch(params: {
  enabled: boolean;
  rootPath: string;
  workspaceIdentity?: string;
  ignoreRulesRoot: string;
  query: string;
}) {
  const { fileService } = useServices();
  const { enabled, rootPath, workspaceIdentity, ignoreRulesRoot, query } = params;
  const key = JSON.stringify([
    rootPath,
    workspaceIdentity?.trim() || rootPath,
    ignoreRulesRoot,
    query,
  ]);
  const [state, setState] = useState<{
    service: typeof fileService;
    key: string;
    files: WorkspaceFileEntry[];
    error: string | null;
  } | null>(null);
  const active = enabled && query.trim().length > 0;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fileService
      .searchWorkspaceFiles({
        rootPath,
        workspaceIdentity,
        ignoreRulesRoot,
        query,
        limit: RESULT_LIMIT,
        matchMode: "terms",
      })
      .then((files) => {
        if (!cancelled)
          setState({
            service: fileService,
            key,
            files: filterCommandCenterFileSearchResults(files, query),
            error: null,
          });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({ service: fileService, key, files: EMPTY_FILES, error: String(error) });
      });
    // 查询/Host/作用域改变或关闭时失效；不让较慢的旧搜索覆盖新输入。
    return () => {
      cancelled = true;
    };
  }, [active, fileService, rootPath, workspaceIdentity, ignoreRulesRoot, query, key]);
  const current = active && state?.service === fileService && state.key === key ? state : null;
  return {
    files: current?.files ?? EMPTY_FILES,
    loading: active && current === null,
    error: current?.error ?? null,
  };
}
