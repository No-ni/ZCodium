import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserGuestManager } from "./browserGuestManager.js";

const fixtures = vi.hoisted(() => ({ guests: new Map<number, unknown>() }));
vi.mock("electron", () => ({
  webContents: { fromId: (id: number) => fixtures.guests.get(id) },
}));

const managers: BrowserGuestManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.disposeAll();
  fixtures.guests.clear();
});

function guest(id: number) {
  let attached = false;
  let destroyed = false;
  const debug = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: vi.fn(() => {
      attached = false;
    }),
    sendCommand: vi.fn(async () => ({})),
  });
  const contents = Object.assign(new EventEmitter(), {
    id,
    debugger: debug,
    session: new EventEmitter(),
    getType: () => "webview",
    isDestroyed: () => destroyed,
    getURL: () => "https://fixture.invalid/",
    getTitle: () => "Fixture",
    getZoomFactor: () => 1,
    executeJavaScript: vi.fn(async (): Promise<unknown> => ({ width: 1280, height: 720 })),
    isCurrentlyAudible: () => false,
    isBeingCaptured: () => false,
    close: vi.fn(),
    stop: vi.fn(),
    navigationHistory: { getAllEntries: () => [], getActiveIndex: () => -1 },
    destroy() {
      destroyed = true;
      contents.emit("destroyed");
    },
  });
  fixtures.guests.set(id, contents);
  return contents;
}

function manager(onOpen = vi.fn()) {
  const value = new BrowserGuestManager(undefined, undefined, undefined, onOpen);
  managers.push(value);
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("BrowserGuestManager destroyed listener ownership", () => {
  it("keeps one destroyed listener while the same guest changes active state 100 times", () => {
    const owner = manager();
    const contents = guest(1);
    for (let index = 0; index < 100; index++) {
      expect(
        owner.attachGuest("browser:fixture", 1, { active: index % 2 === 0, windowId: 1 }).ok,
      ).toBe(true);
      expect(contents.listenerCount("destroyed")).toBe(1);
    }
    owner.disposeAll();
    expect(contents.listenerCount("destroyed")).toBe(0);
  });

  it("releases the previous guest and ignores an already captured old callback", () => {
    const onOpen = vi.fn();
    const owner = manager(onOpen);
    const previous = guest(1);
    const replacement = guest(2);
    expect(owner.attachGuest("browser:fixture", 1).ok).toBe(true);
    const stale = previous.listeners("destroyed")[0];
    if (!stale) throw new Error("Expected a destroyed listener for the current guest");
    expect(owner.attachGuest("browser:fixture", 2).ok).toBe(true);
    expect(previous.listenerCount("destroyed")).toBe(0);
    expect(replacement.listenerCount("destroyed")).toBe(1);
    stale();
    expect(owner.hasGuest("browser:fixture")).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
    replacement.destroy();
    expect(owner.hasGuest("browser:fixture")).toBe(false);
    expect(replacement.listenerCount("destroyed")).toBe(0);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("releases its own listener on explicit detach while preserving other owners", () => {
    const owner = manager();
    const contents = guest(1);
    const external = vi.fn();
    contents.on("destroyed", external);
    expect(owner.attachGuest("browser:fixture", 1).ok).toBe(true);
    expect(contents.listenerCount("destroyed")).toBe(2);
    owner.detach("browser:fixture");
    expect(contents.listeners("destroyed")).toEqual([external]);
    expect(owner.attachGuest("browser:fixture", 1).ok).toBe(true);
    expect(contents.listenerCount("destroyed")).toBe(2);
    owner.disposeAll();
    expect(contents.listeners("destroyed")).toEqual([external]);
  });

  it("retains the native CDP crash guard before guest destruction", () => {
    const owner = manager();
    const contents = guest(1);
    expect(owner.attachGuest("browser:fixture", 1).ok).toBe(true);
    expect(contents.debugger.isAttached()).toBe(true);
    contents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(contents.debugger.detach).toHaveBeenCalledTimes(1);
    expect(contents.debugger.isAttached()).toBe(false);
    contents.destroy();
    expect(owner.hasGuest("browser:fixture")).toBe(false);
    expect(contents.listenerCount("render-process-gone")).toBe(0);
    expect(contents.listenerCount("destroyed")).toBe(0);
    expect(contents.debugger.detach).toHaveBeenCalledTimes(1);
  });

  it("continues native CDP cleanup if removing the destroyed listener throws", () => {
    const owner = manager();
    const contents = guest(1);
    expect(owner.attachGuest("browser:fixture", 1).ok).toBe(true);
    const removal = vi.spyOn(contents, "removeListener").mockImplementationOnce(() => {
      throw new Error("fixture destroyed object");
    });
    try {
      expect(() => owner.detach("browser:fixture")).not.toThrow();
      expect(owner.hasGuest("browser:fixture")).toBe(false);
      expect(contents.debugger.detach).toHaveBeenCalledTimes(1);
      expect(contents.listenerCount("render-process-gone")).toBe(0);
    } finally {
      removal.mockRestore();
      contents.destroy();
    }
  });

  it("drops a tab summary when the tab closes during viewport reading", async () => {
    const owner = manager();
    const contents = guest(1);
    const viewport = deferred<unknown>();
    contents.executeJavaScript = vi.fn(() => viewport.promise);
    expect(
      owner.attachGuest("tab:fixture", 1, {
        windowId: 1,
        workspaceKey: "workspace:fixture",
        sessionId: "session:fixture",
      }).ok,
    ).toBe(true);

    const context = {
      requestId: "list:fixture",
      browserId: "unclaimed-iab",
      browserGeneration: 0,
      windowId: 1,
      workspaceKey: "workspace:fixture",
      sessionId: "session:fixture",
      clientMode: "desktop-continuous" as const,
    };
    const listing = owner.execute(context, { method: "list" });
    expect(contents.executeJavaScript).toHaveBeenCalledOnce();
    await owner.execute(
      { ...context, requestId: "close:fixture" },
      { method: "closeSession", closeTabs: true },
    );
    viewport.resolve({ width: 1280, height: 720 });

    await expect(listing).resolves.toMatchObject({ ok: true, tabs: [] });
  });
});
describe("BrowserGuestManager download listener ownership on the shared session", () => {
  function sharedSessionGuest(
    id: number,
    session: EventEmitter,
    options?: { sessionThrowsWhenDestroyed?: boolean },
  ) {
    let destroyed = false;
    const debug = Object.assign(new EventEmitter(), {
      isAttached: () => true,
      attach: () => undefined,
      detach: vi.fn(),
      sendCommand: vi.fn(async () => ({})),
    });
    const contents = Object.assign(new EventEmitter(), {
      id,
      debugger: debug,
      get session() {
        // 已销毁 guest 上访问 .session 会抛 "Object has been destroyed"；
        // 生产实现必须在 attach 时捕获 session，不能把访问留到 cleanup。
        if (options?.sessionThrowsWhenDestroyed && destroyed) {
          throw new Error("Object has been destroyed");
        }
        return session;
      },
      getType: () => "webview",
      isDestroyed: () => destroyed,
      getURL: () => "https://fixture.invalid/",
      getTitle: () => "Fixture",
      getZoomFactor: () => 1,
      executeJavaScript: vi.fn(async (): Promise<unknown> => ({ width: 1280, height: 720 })),
      isCurrentlyAudible: () => false,
      isBeingCaptured: () => false,
      close: vi.fn(),
      stop: vi.fn(),
      navigationHistory: { getAllEntries: () => [], getActiveIndex: () => -1 },
      destroy() {
        destroyed = true;
        contents.emit("destroyed");
      },
    });
    fixtures.guests.set(id, contents);
    return contents;
  }

  function downloadItem(path: string) {
    return Object.assign(new EventEmitter(), {
      getSavePath: () => path,
    });
  }

  function downloadContext(requestId: string) {
    return {
      requestId,
      browserId: "unclaimed-iab",
      browserGeneration: 0,
      windowId: 1,
      workspaceKey: "workspace:fixture",
      sessionId: "session:fixture",
      clientMode: "desktop-continuous" as const,
    };
  }

  it("removes the will-download listener when the guest is destroyed before detach", () => {
    const owner = manager();
    const session = new EventEmitter();
    const contents = sharedSessionGuest(1, session);
    expect(owner.attachGuest("browser:fixture", 1).ok).toBe(true);
    expect(session.listenerCount("will-download")).toBe(1);
    contents.destroy();
    expect(owner.hasGuest("browser:fixture")).toBe(false);
    expect(session.listenerCount("will-download")).toBe(0);
  });

  it("removes the will-download listener even when the destroyed guest throws on session access", () => {
    const owner = manager();
    const session = new EventEmitter();
    const contents = sharedSessionGuest(1, session, { sessionThrowsWhenDestroyed: true });
    expect(owner.attachGuest("browser:fixture", 1).ok).toBe(true);
    expect(session.listenerCount("will-download")).toBe(1);
    contents.destroy();
    expect(session.listenerCount("will-download")).toBe(0);
  });

  it("keeps the shared session at zero will-download listeners while guests rotate", () => {
    const owner = manager();
    const session = new EventEmitter();
    for (let index = 0; index < 5; index += 1) {
      const contents = sharedSessionGuest(index + 1, session);
      expect(owner.attachGuest("browser:fixture", index + 1).ok).toBe(true);
      expect(session.listenerCount("will-download")).toBe(1);
      contents.destroy();
      expect(session.listenerCount("will-download")).toBe(0);
    }
  });

  it("does not remove another tab's will-download listener", () => {
    const owner = manager();
    const session = new EventEmitter();
    const first = sharedSessionGuest(1, session);
    const second = sharedSessionGuest(2, session);
    expect(owner.attachGuest("browser:a", 1).ok).toBe(true);
    expect(owner.attachGuest("browser:b", 2).ok).toBe(true);
    expect(session.listenerCount("will-download")).toBe(2);
    first.destroy();
    expect(session.listenerCount("will-download")).toBe(1);
    second.destroy();
    expect(session.listenerCount("will-download")).toBe(0);
  });

  it("keeps normal download and onDone working through the production command path", async () => {
    const owner = manager();
    const session = new EventEmitter();
    const contents = sharedSessionGuest(1, session);
    expect(
      owner.attachGuest("browser:fixture", 1, {
        windowId: 1,
        workspaceKey: "workspace:fixture",
        sessionId: "session:fixture",
      }).ok,
    ).toBe(true);
    const waitCommand: Parameters<typeof owner.execute>[1] = {
      method: "playwright",
      action: { name: "waitForEvent", event: "download", timeoutMs: 1000 },
    };
    const waiting = owner.execute(downloadContext("download:wait"), waitCommand);
    const item = downloadItem("C:\\fixture\\file.bin");
    session.emit("will-download", {}, item, contents);
    const waited = await waiting;
    expect(waited).toMatchObject({ ok: true });
    const downloadId = (waited as { value: { id: string } }).value.id;
    expect(typeof downloadId).toBe("string");
    item.emit("done", {}, "completed");
    const pathCommand: Parameters<typeof owner.execute>[1] = {
      method: "playwright",
      action: { name: "downloadPath", downloadId, timeoutMs: 1000 },
    };
    const resolved = await owner.execute(downloadContext("download:path"), pathCommand);
    expect(resolved).toMatchObject({ ok: true, value: "C:\\fixture\\file.bin" });
  });

  it("stays idempotent when detach repeats after destruction", () => {
    const owner = manager();
    const session = new EventEmitter();
    const contents = sharedSessionGuest(1, session);
    expect(owner.attachGuest("browser:fixture", 1).ok).toBe(true);
    contents.destroy();
    expect(session.listenerCount("will-download")).toBe(0);
    expect(() => owner.detach("browser:fixture")).not.toThrow();
    expect(session.listenerCount("will-download")).toBe(0);
    contents.destroy();
    expect(session.listenerCount("will-download")).toBe(0);
  });

  it("removes the will-download listener on explicit detach while the guest is alive", () => {
    const owner = manager();
    const session = new EventEmitter();
    sharedSessionGuest(1, session);
    expect(owner.attachGuest("browser:fixture", 1).ok).toBe(true);
    expect(session.listenerCount("will-download")).toBe(1);
    owner.detach("browser:fixture");
    expect(session.listenerCount("will-download")).toBe(0);
  });
});
