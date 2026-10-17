import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { fetchWorkspaceFileEntriesPacked } from "@/workspace-file-search/fetchWorkspaceFileEntries.js";
import { useWorkspaceFileSearchFilterEntries } from "@/workspace-file-search/useWorkspaceFileSearchFilter.js";

interface WorkspaceFileSearchIndexState {
  packed: string;
  loading: boolean;
  loaded: boolean;
  error: Error | null;
  refresh: () => void;
}

export function useWorkspaceFileSearchIndex({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  enabled,
  ignoreRulesRoot,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  enabled: boolean;
  /**
   * 忽略规则根。搜索根是会话执行 cwd 时必须传对话根（tab 的 workspacePath），
   * 否则规则文件会被写进会话目录（见 conversation-session-workspace spec 规则 10）。
   */
  ignoreRulesRoot?: string;
}): WorkspaceFileSearchIndexState {
  const { fileService } = useWorkspaceServices(
    workspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
    undefined,
    "exact",
  );
  // packed 直存（Host 返回列式字符串）：全量索引只在 worker 解包，树使用有界搜索结果。
  // 索引作用域 = 解包基准（workspacePath）+ 归属身份（workspace/远端会话）+ 忽略规则根。
  // 只要其中一个变了，已取回的 packed 就不再属于当前根：解包基准变了，entries 里的相对/绝对
  // 路径全部按旧根算；规则根变了，条目集合也按旧规则过滤。
  const indexScopeKey = `${workspaceIdentity ?? ""}\u0000${workspaceRemoteSessionId ?? ""}\u0000${workspacePath}\u0000${ignoreRulesRoot ?? ""}`;
  // Bug 原因：packed 过去只有一份裸字符串，作用域切换后旧索引会在 effect 清理**之前**的那一帧
  // 按新 workspacePath 解包（错误路径进入文件树），清理发生在绘制之后、救不了首帧。
  // 现在把「它是为哪个作用域取的」和 payload 一起存，渲染期派生「无数据」；
  // effect 清理保留为状态收敛，不再承担首帧正确性。
  const [packedState, setPackedState] = useState<{ scopeKey: string; packed: string } | null>(null);
  const packed = packedState?.scopeKey === indexScopeKey ? packedState.packed : "";
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestVersionRef = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    setPackedState(null);
    setLoading(false);
    setLoaded(false);
    setError(null);
    requestVersionRef.current += 1;
    // ignoreRulesRoot 也参与索引签名（见 fetchWorkspaceFileEntriesPacked），漏进依赖数组会让
    // 换规则根后仍沿用旧作用域；它必须与上面的 indexScopeKey 保持同一组输入。
  }, [ignoreRulesRoot, workspaceIdentity, workspacePath, workspaceRemoteSessionId]);

  const refresh = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const currentVersion = requestVersionRef.current + 1;
    requestVersionRef.current = currentVersion;
    setLoading(true);
    setError(null);

    void fetchWorkspaceFileEntriesPacked(
      fileService,
      workspacePath,
      ignoreRulesRoot,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted || requestVersionRef.current !== currentVersion) {
          return;
        }
        setPackedState({ scopeKey: indexScopeKey, packed: result });
        setLoaded(true);
      })
      .catch((nextError) => {
        if (controller.signal.aborted || requestVersionRef.current !== currentVersion) {
          return;
        }
        setError(nextError instanceof Error ? nextError : new Error(String(nextError)));
      })
      .finally(() => {
        if (!controller.signal.aborted && requestVersionRef.current === currentVersion) {
          setLoading(false);
        }
      });
    // 不再发送已关闭或过期 scope 的剩余分块；正在执行的 RPC 仍按原服务契约收口。
    return () => controller.abort();
  }, [enabled, fileService, ignoreRulesRoot, indexScopeKey, refreshVersion, workspacePath]);

  return {
    packed,
    loading,
    loaded,
    error,
    refresh,
  };
}

export function useWorkspaceFileSearchResults({
  packed,
  query,
  workspacePath,
}: {
  packed: string;
  query: string;
  workspacePath: string;
}): WorkspaceFileEntry[] {
  // 文件树只展示 Worker 返回的有界结果，完整索引曾在主线程解包再打包。
  // 直接透传 Host packed，避免每次索引更新都重复构建完整 entries 及编码字符串。
  // requireQuery: true 保持"空 query 不出结果"的文件树搜索行为。
  const { items } = useWorkspaceFileSearchFilterEntries(
    packed,
    query,
    { requireQuery: true },
    workspacePath,
  );
  return items;
}
