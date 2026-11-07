import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

// 只替换 electron 的 shell：desktopMainIpcHelpers 在模块顶层 import 了 electron.shell，
// 本机 Node 直接 import 拿不到 Electron 运行时，必须在这里给桩。
const shellMock = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string): Promise<void> => {}),
  openPath: vi.fn(async (_path: string): Promise<string> => ""),
}));

vi.mock("electron", () => ({ shell: shellMock }));

import {
  handleExternalOpenRequest,
  openPathInDefaultApp,
  resolveExternalOpen,
} from "#src/main/desktopMainIpcHelpers.js";

// QA-BUG-003：合成路径只用于构造 file URL，不需要真实落盘。
// 覆盖中文 + 空格 + 字面百分号（URL 里是 %25）；Windows 下 resolve 自带盘符。
const FIXTURE_PATH = resolve("qa-003-fixture", "QA-003 中文 素材", "页面 100%.html");
const FIXTURE_URL = pathToFileURL(FIXTURE_PATH).href;

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function createExit() {
  return {
    openExternal: vi.fn(async (_url: string): Promise<void> => {}),
    openPathInDefaultApp: vi.fn(async (_path: string) => ({ success: true })),
  };
}

describe("resolveExternalOpen：file URL 解码合同", () => {
  it("中文、空格、字面百分号与盘符按 fileURLToPath 解码成本地路径", () => {
    expect(FIXTURE_URL).toContain("%20");
    expect(FIXTURE_URL).toContain("100%25");

    expect(resolveExternalOpen(FIXTURE_URL)).toEqual({
      ok: true,
      target: { kind: "local-path", path: FIXTURE_PATH },
    });

    const decoded = resolveExternalOpen(FIXTURE_URL);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.target.kind !== "local-path") throw new Error("unreachable");
    expect(decoded.target.path).toContain("中文");
    expect(decoded.target.path).toContain(" ");
    // 字面百分号必须是单个 %，不能残留 URL 转义的 %25。
    expect(decoded.target.path).toContain("100%");
    expect(decoded.target.path).not.toContain("%25");
  });

  it.runIf(process.platform === "win32")(
    "Windows 盘符 file URL（file:///C:/...）解码成 C:\\ 形式",
    () => {
      expect(
        resolveExternalOpen(
          "file:///C:/QA-003%20%E4%B8%AD%E6%96%87/%E9%A1%B5%E9%9D%A2%20100%25.html",
        ),
      ).toEqual({
        ok: true,
        target: { kind: "local-path", path: "C:\\QA-003 中文\\页面 100%.html" },
      });
    },
  );

  it("空 host 与 localhost（含大小写）都按本地路径处理", () => {
    const withHost = (host: string) => FIXTURE_URL.replace("file://", `file://${host}`);
    for (const raw of [FIXTURE_URL, withHost("localhost"), withHost("LOCALHOST")]) {
      expect(resolveExternalOpen(raw)).toEqual({
        ok: true,
        target: { kind: "local-path", path: FIXTURE_PATH },
      });
    }
  });

  it("UNC 与远端 host 按不支持拒绝，不产出本地路径", () => {
    // 本仓 Node 24/Windows 上 fileURLToPath("file://server/share/x") 会直接返回
    // \\server\share\x 而不报错，所以必须在 host 层 fail-closed。
    for (const raw of [
      "file://server/share/%E9%A1%B5%E9%9D%A2.html",
      "file://192.168.1.20/share/%E9%A1%B5%E9%9D%A2.html",
      "file://fileserver.example.com/share/x.html",
    ]) {
      expect(resolveExternalOpen(raw)).toEqual({ ok: false, reason: "unsupported-file-host" });
    }
  });
});

describe("resolveExternalOpen：协议分流", () => {
  it("http/https 归为外部 URL，参数原样不改写", () => {
    for (const raw of ["https://example.com/a?b=1#c", "http://127.0.0.1:3000/x%20y"]) {
      expect(resolveExternalOpen(raw)).toEqual({
        ok: true,
        target: { kind: "external-url", url: raw },
      });
    }
  });

  it("其他协议归为不支持，且不产生任何打开目标", () => {
    for (const raw of [
      "about:blank",
      "data:text/html,<h1>x</h1>",
      "javascript:alert(1)",
      "ms-settings:privacy",
      "ftp://example.com/x",
    ]) {
      expect(resolveExternalOpen(raw)).toEqual({ ok: false, reason: "unsupported-protocol" });
    }
  });

  it("无法解析的输入归为 invalid-url", () => {
    for (const raw of ["", "not a url", "http://"]) {
      expect(resolveExternalOpen(raw)).toEqual({ ok: false, reason: "invalid-url" });
    }
  });
});

describe("handleExternalOpenRequest：出口选择", () => {
  it("file URL 只调用本地路径出口，且收到解码后的路径", async () => {
    const exit = createExit();
    await handleExternalOpenRequest(FIXTURE_URL, exit, createLogger());

    expect(exit.openPathInDefaultApp).toHaveBeenCalledTimes(1);
    expect(exit.openPathInDefaultApp).toHaveBeenCalledWith(FIXTURE_PATH);
    expect(exit.openExternal).not.toHaveBeenCalled();
  });

  it("http/https 只调用 openExternal，不触达本地路径出口", async () => {
    for (const raw of ["https://example.com/a?b=1#c", "http://localhost:8080/index.html"]) {
      const exit = createExit();
      await handleExternalOpenRequest(raw, exit, createLogger());

      expect(exit.openExternal).toHaveBeenCalledTimes(1);
      expect(exit.openExternal).toHaveBeenCalledWith(raw);
      expect(exit.openPathInDefaultApp).not.toHaveBeenCalled();
    }
  });

  it("其他协议与非法 file host 不触达任何出口", async () => {
    for (const raw of [
      "about:blank",
      "data:text/html,<h1>x</h1>",
      "javascript:alert(1)",
      "ms-settings:privacy",
      "ftp://example.com/x",
      "file://server/share/x.html",
      "file://192.168.1.20/share/x.html",
      "",
      "not a url",
    ]) {
      const exit = createExit();
      const logger = createLogger();
      await handleExternalOpenRequest(raw, exit, logger);

      expect(exit.openExternal).not.toHaveBeenCalled();
      expect(exit.openPathInDefaultApp).not.toHaveBeenCalled();
      // fail-closed 语义：拒绝只落 Main 日志，且不回显完整 URL/本地路径。
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const logged = logger.warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
      expect(logged?.reason).toBeTypeOf("string");
      if (raw) {
        // 拒绝日志只带稳定 reason，不回显原始 URL/本地路径。
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(raw);
      }
    }
  });

  it("出口抛错只记 warn，不向 renderer 外抛", async () => {
    const exit = {
      openExternal: vi.fn(async (_url: string): Promise<void> => {
        throw new Error("openExternal boom");
      }),
      openPathInDefaultApp: vi.fn(async (_path: string) => {
        throw new Error("openPath boom");
      }),
    };
    const logger = createLogger();

    await expect(
      handleExternalOpenRequest("https://example.com/x", exit, logger),
    ).resolves.toBeUndefined();
    await expect(handleExternalOpenRequest(FIXTURE_URL, exit, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

describe("接线：file URL 最终落到 shell.openPath", () => {
  it("file URL 让 shell.openPath 收到解码后的路径，shell.openExternal 零次", async () => {
    shellMock.openPath.mockClear();
    shellMock.openExternal.mockClear();
    const logger = createLogger();

    await handleExternalOpenRequest(
      FIXTURE_URL,
      {
        openExternal: (url) => shellMock.openExternal(url),
        openPathInDefaultApp: (path) => openPathInDefaultApp(path, logger),
      },
      logger,
    );

    expect(shellMock.openExternal).not.toHaveBeenCalled();
    expect(shellMock.openPath).toHaveBeenCalledTimes(1);
    const openedPath = String(shellMock.openPath.mock.calls[0]?.[0]);
    expect(openedPath).toContain(join("QA-003 中文 素材", "页面 100%.html"));
    expect(openedPath).not.toContain("%25");
    expect(openedPath).not.toContain("%20");
  });

  it("http 只到 shell.openExternal，UNC host 一个出口都不碰", async () => {
    shellMock.openPath.mockClear();
    shellMock.openExternal.mockClear();
    const logger = createLogger();
    const exit = {
      openExternal: (url: string) => shellMock.openExternal(url),
      openPathInDefaultApp: (path: string) => openPathInDefaultApp(path, logger),
    };

    await handleExternalOpenRequest("https://example.com/a", exit, logger);
    await handleExternalOpenRequest("file://server/share/x.html", exit, logger);

    expect(shellMock.openExternal).toHaveBeenCalledTimes(1);
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });
});
