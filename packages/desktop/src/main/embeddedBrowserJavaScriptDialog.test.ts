import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddedBrowserJavaScriptDialogController } from "./embeddedBrowserJavaScriptDialog.js";

const electronMock = vi.hoisted(() => ({
  browserWindowFromId: vi.fn(),
  createFromPath: vi.fn(),
  showMessageBoxSync: vi.fn(),
  webContentsFromId: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromId: electronMock.browserWindowFromId },
  dialog: { showMessageBoxSync: electronMock.showMessageBoxSync },
  nativeImage: { createFromPath: electronMock.createFromPath },
  webContents: { fromId: electronMock.webContentsFromId },
}));

interface TestGuest extends EventEmitter {
  isDestroyed(): boolean;
  getType(): string;
  getURL(): string;
}

const guests = new Map<number, TestGuest>();
const parentWindow = { isDestroyed: () => false };
const logger = { warn: vi.fn() };

function createGuest(url = "https://guest.example/page"): TestGuest {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => url,
  });
}

function createController(): EmbeddedBrowserJavaScriptDialogController {
  return new EmbeddedBrowserJavaScriptDialogController({
    iconPath: "/fixture/icon.png",
    getLocale: () => "en-US",
    logger,
  });
}

beforeEach(() => {
  guests.clear();
  electronMock.browserWindowFromId.mockReset();
  electronMock.browserWindowFromId.mockReturnValue(parentWindow);
  electronMock.createFromPath.mockReset();
  electronMock.createFromPath.mockReturnValue({ isEmpty: () => true });
  electronMock.showMessageBoxSync.mockReset();
  electronMock.showMessageBoxSync.mockReturnValue(1);
  electronMock.webContentsFromId.mockReset();
  electronMock.webContentsFromId.mockImplementation((id: number) => guests.get(id));
  logger.warn.mockReset();
});

describe("EmbeddedBrowserJavaScriptDialogController guest listener ownership", () => {
  it("keeps one destroyed listener across repeated binds and removes it on dispose", () => {
    const guest = createGuest();
    const otherOwnerDestroyed = vi.fn();
    guest.once("destroyed", otherOwnerDestroyed);
    guests.set(7, guest);
    const controller = createController();

    for (let index = 0; index < 100; index += 1) {
      controller.bindGuest(`browser:tab-${index}`, 7, 3);
    }

    expect(guest.listenerCount("destroyed")).toBe(2);
    controller.dispose();
    expect(guest.listenerCount("destroyed")).toBe(1);
    expect(guest.listeners("destroyed")).toContain(otherOwnerDestroyed);
    guest.emit("destroyed");
    expect(otherOwnerDestroyed).toHaveBeenCalledTimes(1);
    expect(guest.listenerCount("destroyed")).toBe(0);
  });

  it("releases a replaced Guest and ignores its late destroy before handling the new dialog", () => {
    const oldGuest = createGuest("https://old.example/page");
    const otherOldOwnerDestroyed = vi.fn();
    oldGuest.once("destroyed", otherOldOwnerDestroyed);
    const newGuest = createGuest("https://new.example/page");
    guests.set(7, oldGuest);
    const controller = createController();
    controller.bindGuest("browser:tab", 7, 3);
    const oldDestroyedCallback = oldGuest
      .listeners("destroyed")
      .find((listener) => listener !== otherOldOwnerDestroyed);

    guests.set(7, newGuest);
    controller.bindGuest("browser:tab", 7, 4);

    expect(oldGuest.listenerCount("destroyed")).toBe(1);
    expect(oldGuest.listeners("destroyed")).toContain(otherOldOwnerDestroyed);
    expect(newGuest.listenerCount("destroyed")).toBe(1);
    expect(oldDestroyedCallback).toBeTypeOf("function");
    oldDestroyedCallback?.();
    expect(
      controller.handleDialogRequest(7, "https://frame.example/", {
        type: "confirm",
        message: "Continue?",
      }),
    ).toEqual({ handled: true, value: true });
    expect(electronMock.browserWindowFromId).toHaveBeenCalledWith(4);
    expect(electronMock.showMessageBoxSync).toHaveBeenCalledTimes(1);
    oldGuest.emit("destroyed");
    expect(otherOldOwnerDestroyed).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("removes the previous Guest listener when the replacement tab id is invalid", () => {
    const guest = createGuest();
    const otherOwnerDestroyed = vi.fn();
    guest.once("destroyed", otherOwnerDestroyed);
    guests.set(7, guest);
    const controller = createController();
    controller.bindGuest("browser:tab", 7, 3);

    controller.bindGuest("not-a-browser-tab", 7, 3);

    expect(guest.listenerCount("destroyed")).toBe(1);
    expect(guest.listeners("destroyed")).toContain(otherOwnerDestroyed);
    expect(
      controller.handleDialogRequest(7, "https://frame.example/", {
        type: "alert",
        message: "Notice",
      }),
    ).toEqual({ handled: false });
    guest.emit("destroyed");
    expect(otherOwnerDestroyed).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("clears its listener and registration when the current Guest is destroyed", () => {
    const guest = createGuest();
    guests.set(7, guest);
    const controller = createController();
    controller.bindGuest("browser:tab", 7, 3);

    guest.emit("destroyed");

    expect(guest.listenerCount("destroyed")).toBe(0);
    expect(
      controller.handleDialogRequest(7, "https://frame.example/", {
        type: "alert",
        message: "Notice",
      }),
    ).toEqual({ handled: false });
    controller.dispose();
  });
});
