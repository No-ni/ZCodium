import { BrowserWindow } from "electron";
import type {
  WebRemoteControlBridgeDescriptor,
  WebRemoteControlFailureReason,
  WebRemoteControlWorkspaceRef,
} from "@zcode/shared";
import type { WebRemoteControlLogger } from "./logger.js";
import type { WebRemoteControlRuntime } from "./runtime.js";
import type { WebRemoteControlManagerDeps } from "./manager.js";
import { attachWorkspaceHostPort, openWebRemoteControlHostBridge } from "./hostBridge.js";

/**
 * workspace-bridge-open 处理：校验目标工作区属于当前桌面窗口 → 挂本地 Host port →
 * 建 RPC 装配器。返回 ready/error 信封载荷，由 payloadRouter 发送。
 */

export interface BridgeOpenRequest {
  requestId: string;
  bridgeSessionId: string;
  workspaceKey: string;
  taskId?: string;
  bridgeGeneration?: number;
  recoveryId?: string;
}

export type BridgeOpenResult =
  | { ok: true; bridge: WebRemoteControlBridgeDescriptor }
  | { ok: false; reason: WebRemoteControlFailureReason; error: string };

/** 清单变化只撤销受影响的 attachment；标签、任务状态等展示字段不参与 scope 判定。 */
export function closeChangedWorkspaceBridge(
  runtime: WebRemoteControlRuntime,
  previous: WebRemoteControlWorkspaceRef | undefined,
): string | undefined {
  const bridge = runtime.bridge;
  if (!bridge) return;
  const current = runtime.workspaces.find((item) => item.workspaceKey === bridge.workspaceKey);
  if (
    previous &&
    current &&
    previous.workspacePath === current.workspacePath &&
    (previous.workspaceIdentity?.trim() || "") === (current.workspaceIdentity?.trim() || "") &&
    previous.remoteSessionId === current.remoteSessionId &&
    previous.kind === current.kind &&
    !(
      current.kind === "remote" &&
      current.connectionState !== undefined &&
      current.connectionState !== "connected"
    )
  )
    return;
  // open 时的校验不能覆盖后续关工作区/远端换代；先摘掉单槽再释放，阻止旧帧继续访问 Host。
  runtime.bridge = undefined;
  bridge.dispose();
  return bridge.bridgeSessionId;
}

export function openWorkspaceBridge(
  runtime: WebRemoteControlRuntime,
  request: BridgeOpenRequest,
  deps: WebRemoteControlManagerDeps,
  sendAppPayload: (runtime: WebRemoteControlRuntime, payload: never) => void,
): BridgeOpenResult {
  // spec：只访问桌面当前窗口已经打开的工作区。
  const target = runtime.workspaces.find((item) => item.workspaceKey === request.workspaceKey);
  const fail = (reason: WebRemoteControlFailureReason, error: string): BridgeOpenResult => {
    deps.logger.warn("[web-remote-control] workspace bridge rejected", {
      windowId: runtime.windowId,
      workspaceKey: request.workspaceKey,
      reason,
    });
    return { ok: false, reason, error };
  };
  if (!target) {
    return fail(
      "unsupportedAction",
      "目标工作区不在当前桌面窗口中，无法创建 Web 远程控制 bridge。",
    );
  }
  if (target.kind === "remote") {
    // 清单中的 connected 不能替代完整远端身份；缺 session 时 attachment helper 会选择 local scope。
    if (!target.remoteSessionId?.trim() || !target.workspaceIdentity?.trim()) {
      return fail("invalidMobileConnection", "远程工作区身份尚未就绪，请先在桌面端重连。");
    }
    // 权威态优先取同步时已覆盖的值；缺失时走修因路径重新解析桌面 remote session 路由表，
    // 既不放行也不默认断开。仍拿不到才 fail-closed，避免用超时/默认值掩盖同步问题。
    const authoritativeConnectionState =
      target.connectionState ??
      (target.remoteSessionId
        ? deps.resolveRemoteWorkspaceConnectionState?.(target.remoteSessionId)
        : undefined);
    if (authoritativeConnectionState === undefined) {
      deps.logger.warn("[web-remote-control] 无法确认远端连接态，拒绝创建 bridge", {
        windowId: runtime.windowId,
        workspaceKey: request.workspaceKey,
        remoteSessionId: target.remoteSessionId,
      });
      return fail(
        "invalidMobileConnection",
        "无法确认远程工作区连接态，请稍后重试或先在桌面端重连。",
      );
    }
    if (authoritativeConnectionState !== "connected") {
      return fail("invalidMobileConnection", "目标远程工作区尚未连接，请先在桌面端重连。");
    }
  }
  const webContentsId = BrowserWindow.fromId(runtime.windowId)?.webContents.id;
  if (webContentsId === undefined) {
    return fail("workspaceClosed", "桌面窗口已关闭。");
  }
  runtime.bridge?.dispose();
  runtime.bridge = undefined;
  let attachment;
  let opened;
  try {
    attachment = attachWorkspaceHostPort({
      windowId: runtime.windowId,
      webContentsId,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      resolveHostProcess: deps.resolveHostProcess,
      logger: deps.logger,
    });
    opened = openWebRemoteControlHostBridge({
      attachment,
      bridgeSessionId: request.bridgeSessionId,
      emitFrame: (envelope) => {
        sendAppPayload(runtime, envelope as never);
        return runtime.mobileConnected;
      },
      onDegraded: (reason) => {
        const bridge = runtime.bridge;
        if (!bridge || bridge.degraded) return;
        bridge.degraded = true;
        deps.logger.warn("[web-remote-control] raw relay bridge degraded", {
          windowId: runtime.windowId,
          bridgeSessionId: bridge.bridgeSessionId,
          reason,
        });
        sendAppPayload(runtime, {
          zcode_type: "bridge-degraded",
          bridgeSessionId: bridge.bridgeSessionId,
          bridgeGeneration: request.bridgeGeneration,
          recoveryId: request.recoveryId,
          reason: "rpc-transport-fault",
        } as never);
      },
      logger: deps.logger,
    });
  } catch (error) {
    if (attachment) {
      try {
        attachment.dispose();
      } catch (disposeError) {
        try {
          deps.logger.warn(
            "[web-remote-control] attachment cleanup failed after bridge open error",
            {
              windowId: runtime.windowId,
              attachmentId: attachment.attachmentId,
              error: disposeError instanceof Error ? disposeError.message : String(disposeError),
            },
          );
        } catch {
          // 清理或日志失败不能覆盖 bridge 初始化的原错。
        }
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail("unexpectedError", message);
  }
  runtime.bridge = {
    bridgeSessionId: request.bridgeSessionId,
    workspaceKey: request.workspaceKey,
    attachmentId: attachment.attachmentId,
    acceptFrame: (frame) => opened.bridge.acceptFrame(frame),
    emitAck: (seq) => opened.bridge.emitAck(seq),
    dispose: opened.dispose,
    readyAnnounced: false,
    degraded: false,
  };
  return {
    ok: true,
    bridge: {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      recoveryId: request.recoveryId,
      workspaceKey: request.workspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      kind: target.kind,
      entryKind: request.taskId ? "task" : "home",
    },
  };
}

export type { WebRemoteControlLogger };
