import { describe, expect, it } from "vitest";
import { presentMobileConnection } from "./connectionPresentation.js";

describe("presentMobileConnection", () => {
  it("distinguishes initial connection, authentication, waiting, and paired states", () => {
    expect(presentMobileConnection("connecting")).toMatchObject({
      label: "正在连接桌面",
      description: "正在建立与桌面的连接…",
      terminal: false,
    });
    expect(presentMobileConnection("authenticating").label).toBe("正在验证连接");
    expect(presentMobileConnection("waiting").label).toBe("等待桌面确认");
    expect(presentMobileConnection("paired").label).toBe("已连接到当前桌面窗口");
  });

  it("identifies reconnecting from the close code without creating retry state", () => {
    expect(presentMobileConnection("connecting", { closeCode: 1006 })).toMatchObject({
      label: "正在重新连接",
      description: "连接中断，正在尝试重新连接…",
      terminal: false,
    });
  });

  it.each([
    ["AUTH_FAILED", "配对信息已失效，请重新扫码连接。"],
    ["WRONG_PARAM", "连接参数无效，请回到桌面端重新获取二维码。"],
  ])("shows safe terminal guidance for %s", (reason, description) => {
    expect(presentMobileConnection("error", { reason })).toMatchObject({
      label: "连接已终止",
      description,
      terminal: true,
    });
  });

  it("asks a kicked page to close, and recognizes rejection only with close code 4001", () => {
    expect(presentMobileConnection("error", { reason: "KICKED" }).description).toContain(
      "关闭其他重复页面",
    );
    expect(presentMobileConnection("connecting", { reason: "CONNECTION_REJECTED" }).terminal).toBe(
      false,
    );
    expect(
      presentMobileConnection("connecting", {
        reason: "CONNECTION_REJECTED",
        closeCode: 4001,
      }),
    ).toMatchObject({
      label: "连接已终止",
      description: "连接请求已被拒绝，请重新扫码获取有效链接。",
      terminal: true,
    });
  });

  it("keeps an INTERNAL 4001 close in retryable reconnect presentation", () => {
    expect(
      presentMobileConnection("connecting", {
        reason: "INTERNAL",
        closeCode: 4001,
      }),
    ).toMatchObject({
      label: "正在重新连接",
      description: "连接中断，正在尝试重新连接…",
      terminal: false,
    });
  });

  it("maps close-only kicked/expired failures to terminal guidance", () => {
    expect(presentMobileConnection("error", { closeCode: 4002, reason: "kicked" })).toEqual(
      presentMobileConnection("error", { reason: "KICKED" }),
    );
    expect(presentMobileConnection("error", { closeCode: 4003, reason: "pair-expired" })).toEqual(
      presentMobileConnection("error", { reason: "AUTH_FAILED" }),
    );
  });

  it("does not expose unknown server reasons or message-like data", () => {
    expect(
      presentMobileConnection("error", {
        reason: "sensitive server text AUTH_FAILED proof=secret",
      }),
    ).toEqual({
      label: "连接异常",
      description: "连接暂时异常，请检查网络后重试。",
      terminal: false,
    });
  });

  it("does not present closed as automatic retry", () => {
    expect(presentMobileConnection("closed")).toMatchObject({
      label: "连接已关闭",
      terminal: false,
    });
  });
});
