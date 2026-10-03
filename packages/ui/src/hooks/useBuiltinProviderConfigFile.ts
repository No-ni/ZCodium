import { useCallback, useEffect, useRef, useState } from "react";
import type { BuiltinProviderConfigFileInfo } from "@zcode/shared";
import { logger } from "@/logger.js";
import { usePlatform } from "@/hooks/usePlatform.js";

export interface BuiltinProviderConfigFileState {
  /** 物化副本路径；未启动过 server 或平台不支持时为 null。 */
  readonly path: string | null;
  readonly exists: boolean;
  readonly loading: boolean;
}

const INITIAL_STATE: BuiltinProviderConfigFileState = {
  path: null,
  exists: false,
  loading: true,
};

/**
 * 读取当前生效的 ZCode Built-in Provider Config 物化副本。
 *
 * 该副本由 Host/Services 启动时从随包配置物化而来，运行时由
 * NodeZCodeBuiltinProviderConfigSource 只读监听；打开源配置对用户无意义
 * （macOS 打包态位于只读 bundle 内）。
 *
 * 带 request-id 竞态防护：快速切换工作区或重复触发时，丢弃过期响应，
 * 避免旧路径覆盖新路径。查询失败只记日志，不向 UI 抛错。
 */
export function useBuiltinProviderConfigFile(): BuiltinProviderConfigFileState {
  const platform = usePlatform();
  const [state, setState] = useState<BuiltinProviderConfigFileState>(INITIAL_STATE);
  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((previous) => ({ ...previous, loading: true }));
    try {
      const info = await platform.getBuiltinProviderConfigFile?.();
      // 过期响应直接丢弃：本次调用期间又发起了新的查询。
      if (requestIdRef.current !== requestId) return;
      setState({
        path: info?.path ?? null,
        exists: info?.exists ?? false,
        loading: false,
      });
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      logger.warn("[useBuiltinProviderConfigFile] 读取 provider 配置路径失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setState({ path: null, exists: false, loading: false });
    }
  }, [platform]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return state;
}

/** 菜单禁用原因；enabled 为 false 时返回非空文案。 */
export function resolveBuiltinProviderConfigDisabledReason(
  state: BuiltinProviderConfigFileState,
  reasons: { loading: string; missing: string; unsupported: string },
): string | null {
  if (state.loading) return reasons.loading;
  if (!state.path) return reasons.unsupported;
  if (!state.exists) return reasons.missing;
  return null;
}

export type { BuiltinProviderConfigFileInfo };
