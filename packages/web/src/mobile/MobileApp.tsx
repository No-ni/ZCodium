import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "@zcode/ui";
import type {
  WebRemoteControlBootstrapResult,
  WebRemoteControlWorkspaceListResult,
} from "@zcode/shared";
import { MobileRemoteControlClient, readPairingParamsFromLocation } from "./protocol.js";
import {
  presentMobileConnection,
  type MobileConnectionSnapshot,
} from "./connectionPresentation.js";
import { SharedMobileRoot } from "./shared-root/index.js";
import { saveBrowserFile } from "../saveBrowserFile.js";

/** 配对与 fresh bootstrap 由入口编排；正文、草稿和提交全部交给共享 Root/CLI。 */
export function MobileApp() {
  const [params, setParams] = useState<ReturnType<typeof readPairingParamsFromLocation> | null>(
    null,
  );
  const [paramsError, setParamsError] = useState(false);
  const clientRef = useRef<MobileRemoteControlClient | null>(null);
  const [client, setClient] = useState<MobileRemoteControlClient | null>(null);
  const [connectionSnapshot, setConnectionSnapshot] = useState<MobileConnectionSnapshot>({
    state: "connecting",
  });
  const [bootstrap, setBootstrap] = useState<WebRemoteControlBootstrapResult | null>(null);
  const bootstrapSequence = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    try {
      setParams(readPairingParamsFromLocation());
    } catch {
      setParamsError(true);
    }
  }, []);

  const updateWorkspaceList = useCallback((result: WebRemoteControlWorkspaceListResult) => {
    setBootstrap((current) =>
      current
        ? {
            ...current,
            workspaces: result.workspaces,
            tasks: result.tasks,
          }
        : current,
    );
  }, []);

  useEffect(() => {
    if (!params) return;
    const next = new MobileRemoteControlClient(params, {
      onStateChange: (state, detail) => {
        if (clientRef.current !== next) return;
        // paired 字符串可以与前一连接相同；每个连接事件都撤旧 bootstrap，重新取可信清单。
        bootstrapSequence.current++;
        setBootstrap(null);
        setNotice(null);
        setConnectionSnapshot({ state, detail });
      },
      onPayload: (payload) => {
        if (clientRef.current !== next || next.getState() !== "paired") return;
        if (payload.zcode_type === "workspace-list-updated") updateWorkspaceList(payload.result);
        if (payload.zcode_type === "app-error") {
          logger.warn("[mobile] 已配对桌面操作失败");
          setNotice("桌面暂时无法完成此操作，请检查连接后重试。");
        }
      },
    });
    clientRef.current = next;
    setClient(next);
    next.connect();
    return () => {
      if (clientRef.current === next) clientRef.current = null;
      bootstrapSequence.current++;
      next.dispose();
    };
  }, [params, updateWorkspaceList]);

  useEffect(() => {
    if (connectionSnapshot.state !== "paired" || !client) return;
    const sequence = ++bootstrapSequence.current;
    void client
      .request({
        zcode_type: "bootstrap-request",
        requestId: `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      })
      .then((response) => {
        if (
          clientRef.current !== client ||
          client.getState() !== "paired" ||
          sequence !== bootstrapSequence.current
        )
          return;
        if (response.zcode_type !== "bootstrap-response")
          throw new Error("mobile-bootstrap-unavailable");
        setBootstrap(response.result);
      })
      .catch(() => {
        // 不把协议错误文本、配置或真实路径写进手机页面/日志。
        if (clientRef.current === client && sequence === bootstrapSequence.current) {
          logger.warn("[mobile] 当前配对 bootstrap 读取失败");
          setNotice("读取桌面工作区失败，请重新连接后重试。");
        }
      });
  }, [client, connectionSnapshot]);

  useEffect(() => {
    const online = () => clientRef.current?.retryNow();
    const visible = () => {
      if (document.visibilityState === "visible") clientRef.current?.retryNow();
    };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  const presentation = paramsError
    ? {
        label: "连接参数无效",
        description: "请回到桌面端重新获取二维码并扫码连接。",
      }
    : presentMobileConnection(connectionSnapshot.state, connectionSnapshot.detail);
  if (!client)
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background px-4 text-foreground">
        <section
          className="w-full max-w-sm rounded-xl border border-border bg-card p-5"
          aria-live="polite"
        >
          <h1 className="text-base font-medium">{presentation.label}</h1>
          <p className="mt-2 text-ui-base text-foreground-subtle">{presentation.description}</p>
        </section>
      </div>
    );
  return (
    <SharedMobileRoot
      client={client}
      connection={connectionSnapshot.state}
      bootstrap={bootstrap}
      title={presentation.label}
      description={presentation.description}
      notice={notice}
      saveFile={saveBrowserFile}
      onWorkspaceListUpdated={updateWorkspaceList}
    />
  );
}
