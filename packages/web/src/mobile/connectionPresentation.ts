import type { MobileConnectionState } from "./protocol.js";

export interface MobileConnectionDetail {
  reason?: string;
  closeCode?: number;
}

export interface MobileConnectionSnapshot {
  state: MobileConnectionState;
  detail?: MobileConnectionDetail;
}

export interface MobileConnectionPresentation {
  label: string;
  description: string;
  terminal: boolean;
}

const TERMINAL_PRESENTATIONS: Record<string, MobileConnectionPresentation> = {
  AUTH_FAILED: {
    label: "连接已终止",
    description: "配对信息已失效，请重新扫码连接。",
    terminal: true,
  },
  KICKED: {
    label: "连接已终止",
    description: "此配对仅支持一个手机页面，请关闭其他重复页面后重新扫码。",
    terminal: true,
  },
  WRONG_PARAM: {
    label: "连接已终止",
    description: "连接参数无效，请回到桌面端重新获取二维码。",
    terminal: true,
  },
};

/** UI 只投影协议状态；未知原因不透传服务端文本，重试仍由协议客户端负责。 */
export function presentMobileConnection(
  state: MobileConnectionState,
  detail?: MobileConnectionDetail,
): MobileConnectionPresentation {
  const terminalPresentation = detail?.reason ? TERMINAL_PRESENTATIONS[detail.reason] : undefined;
  if (terminalPresentation) return terminalPresentation;

  // 终止错误帧可能丢失；关闭码必须呈现同样的互踢/过期语义，不能误报为可重试网络异常。
  if (detail?.closeCode === 4002) return TERMINAL_PRESENTATIONS.KICKED!;
  if (detail?.closeCode === 4003) return TERMINAL_PRESENTATIONS.AUTH_FAILED!;
  if (detail?.closeCode === 4001 && detail.reason === "INTERNAL") {
    // 协议层会对 INTERNAL + 4001 退避重连；这里不能把临时 relay 错误显示成终止拒绝。
    return {
      label: "正在重新连接",
      description: "连接中断，正在尝试重新连接…",
      terminal: false,
    };
  }
  if (detail?.closeCode === 4001) {
    return {
      label: "连接已终止",
      description: "连接请求已被拒绝，请重新扫码获取有效链接。",
      terminal: true,
    };
  }

  switch (state) {
    case "connecting":
      return detail?.closeCode !== undefined
        ? {
            label: "正在重新连接",
            description: "连接中断，正在尝试重新连接…",
            terminal: false,
          }
        : {
            label: "正在连接桌面",
            description: "正在建立与桌面的连接…",
            terminal: false,
          };
    case "authenticating":
      return {
        label: "正在验证连接",
        description: "正在验证配对信息…",
        terminal: false,
      };
    case "waiting":
      return {
        label: "等待桌面确认",
        description: "手机已连接，正在等待桌面端确认配对。",
        terminal: false,
      };
    case "paired":
      return {
        label: "已连接到当前桌面窗口",
        description: "手机已连接到当前桌面窗口。",
        terminal: false,
      };
    case "closed":
      return {
        label: "连接已关闭",
        description: "连接已关闭，请回到桌面端重新扫码连接。",
        terminal: false,
      };
    case "error":
      return {
        label: "连接异常",
        description: "连接暂时异常，请检查网络后重试。",
        terminal: false,
      };
  }
}
