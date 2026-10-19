import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@zcode/shared";
import type { ICredentialService, ISettingService } from "@zcode/services";
import { createWebRemoteControlRelayAuthStorageProvider } from "./authStorage.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function setup() {
  let settings: Partial<AppSettings> = {};
  const credentials = new Map<string, string>();
  const save = vi.fn(async (key: string, value: string) => {
    credentials.set(key, value);
  });
  const storage = createWebRemoteControlRelayAuthStorageProvider({
    settingService: {
      get: async () => settings,
      update: async (patch: Partial<AppSettings>) => {
        settings = { ...settings, ...patch };
      },
    } as ISettingService,
    credentialService: {
      load: async (key: string) => credentials.get(key),
      save,
      delete: async (key: string) => {
        credentials.delete(key);
      },
    } as unknown as ICredentialService,
    logger: { info() {}, warn() {}, error() {} },
  });
  const holdSave = () => {
    const entered = deferred();
    const release = deferred();
    save.mockImplementationOnce(async (key, value) => {
      entered.resolve();
      await release.promise;
      credentials.set(key, value);
    });
    return { entered: entered.promise, release: release.resolve };
  };
  return { storage, credentials, save, holdSave, settings: () => settings };
}
const a = { deviceSid: "test-sid-A", passHash: "test-hash-A" };
const b = { deviceSid: "test-sid-B", passHash: "test-hash-B" };

describe("relay credentials operation ordering", () => {
  it("并发保存不能拼出另一窗口的 SID/hash", async () => {
    const { storage, holdSave } = setup();
    const gate = holdSave();
    const first = storage.save(a);
    await gate.entered;
    const second = storage.save(b);
    await flush();
    gate.release();
    await Promise.all([first, second]);
    expect(await storage.load()).toEqual(b);
  });

  it("写入期间的 load 等完整凭据，不能读取半写入记录", async () => {
    const { storage, holdSave } = setup();
    await storage.save(a);
    const gate = holdSave();
    const saving = storage.save(b);
    await gate.entered;
    let settled = false;
    const loading = storage.load().then((value) => {
      settled = true;
      return value;
    });
    await flush();
    const settledBeforeSave = settled;
    gate.release();
    await saving;
    expect(await loading).toEqual(b);
    expect(settledBeforeSave).toBe(false);
  });

  it("save 期间调用 clear，最终不会遗留晚到的 hash", async () => {
    const { storage, holdSave, settings, credentials } = setup();
    const gate = holdSave();
    const saving = storage.save(a);
    await gate.entered;
    const clearing = storage.clear();
    await flush();
    gate.release();
    await Promise.all([saving, clearing]);
    expect(settings().webRemoteControlExternalRelayDevice).toBeUndefined();
    expect(credentials.size).toBe(0);
  });

  it("保存失败清除半写入记录，后续保存与 rotate 仍可完成", async () => {
    const { storage, save } = setup();
    await storage.save(a);
    save.mockRejectedValueOnce(new Error("controlled save failure"));
    await expect(storage.save(b)).rejects.toThrow("controlled save failure");
    expect(await storage.load()).toBeNull();
    await storage.save(b);
    expect(await storage.load()).toEqual(b);
    await storage.rotate(a);
    expect(await storage.load()).toEqual(a);
  });
});
