import { expect, it, vi } from "vitest";
import type { BotConfig, BotsConfigFile } from "@zcode/shared";
import { createLatestRuntimeRefreshQueue } from "../src/bots/channelRuntime.js";
import { createFeishuChannelRuntime } from "../src/bots/feishuChannelRuntime.js";
import { createTelegramChannelRuntime } from "../src/bots/telegramChannelRuntime.js";
import { createWeixinChannelRuntime } from "../src/bots/weixinChannelRuntime.js";

const factories = [
  createFeishuChannelRuntime,
  createTelegramChannelRuntime,
  createWeixinChannelRuntime,
] as const;
const cases = factories.map((create) => ({ name: create.name, create }));
const empty: BotsConfigFile = { version: 3, bots: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(create: (typeof factories)[number]) {
  const migrated = vi.fn(async () => {});
  const readConfig = vi.fn(async () => empty);
  const load = vi.fn(async (): Promise<string | null> => "synthetic");
  const syncCommands = vi.fn(async () => {});
  const setRuntimeStatus = vi.fn();
  const runtime = create({
    ensureBotStorageMigrated: migrated,
    readConfig,
    credentialService: { load },
    telegramProvider: { syncCommands },
    logger: { warn: vi.fn(), info: vi.fn() },
    statusSink: { setRuntimeStatus, getRuntimeStatus: vi.fn() },
  } as unknown as Parameters<typeof create>[0]);
  return { runtime, migrated, readConfig, load, syncCommands, setRuntimeStatus };
}

it.each(cases)("$name rejects refresh admission after disposal", async ({ create }) => {
  const f = fixture(create);
  await f.runtime.dispose();
  f.runtime.scheduleRefresh();
  await f.runtime.refresh();
  await f.runtime.dispose();
  expect(f.migrated).not.toHaveBeenCalled();
  expect(f.readConfig).not.toHaveBeenCalled();
  expect(f.load).not.toHaveBeenCalled();
  expect(f.syncCommands).not.toHaveBeenCalled();
});

it.each(cases)("$name stops after migration if disposed while waiting", async ({ create }) => {
  const f = fixture(create);
  const entered = deferred<void>();
  const migration = deferred<void>();
  f.migrated.mockImplementation(() => {
    entered.resolve();
    return migration.promise;
  });
  const refreshing = f.runtime.refresh();
  await entered.promise;
  await f.runtime.dispose();
  migration.resolve();
  await refreshing;
  expect(f.readConfig).not.toHaveBeenCalled();
  expect(f.setRuntimeStatus).not.toHaveBeenCalled();
});

it.each(cases)("$name does not start a runtime after late fingerprint IO", async ({ create }) => {
  const f = fixture(create);
  const provider =
    create === createFeishuChannelRuntime
      ? "feishu"
      : create === createTelegramChannelRuntime
        ? "telegram"
        : "weixin";
  const bot: BotConfig = {
    id: "synthetic",
    name: "synthetic",
    provider,
    enabled: true,
    credentialRef: "synthetic",
    feishuAppId: "cli_synthetic",
    allowedWorkspaces: [],
  };
  const entered = deferred<void>();
  const credential = deferred<string>();
  f.load.mockImplementation(() => {
    entered.resolve();
    return credential.promise;
  });
  const refreshing = f.runtime.refresh({ version: 3, bots: [bot] });
  await entered.promise;
  await f.runtime.dispose();
  credential.resolve("synthetic");
  await refreshing;
  // 启动 runtime 会再次读取凭据或写连接状态，迟到 fingerprint 不能越过终态。
  expect(f.load).toHaveBeenCalledOnce();
  expect(f.setRuntimeStatus).not.toHaveBeenCalled();
});

it("closes queued and active generations and does not reopen on repeated disposal", async () => {
  const queue = createLatestRuntimeRefreshQueue();
  const entered = deferred<void>();
  const finish = deferred<void>();
  let latest!: () => boolean;
  const active = queue.enqueue(async (isLatest) => {
    latest = isLatest;
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  expect(latest()).toBe(true);
  const reconcile = vi.fn(async () => {});
  const queued = queue.enqueue(reconcile);
  queue.dispose();
  expect(latest()).toBe(false);
  finish.resolve();
  await Promise.all([active, queued, queue.enqueue(reconcile)]);
  queue.dispose();
  expect(queue.closed).toBe(true);
  expect(reconcile).not.toHaveBeenCalled();
});

it("continues refreshing after a failure while open", async () => {
  const queue = createLatestRuntimeRefreshQueue();
  await expect(
    queue.enqueue(async () => {
      throw new Error("synthetic");
    }),
  ).rejects.toThrow("synthetic");
  const reconcile = vi.fn(async (latest: () => boolean) => {
    expect(latest()).toBe(true);
  });
  await queue.enqueue(reconcile);
  expect(reconcile).toHaveBeenCalledOnce();
  queue.dispose();
});

it("does not dispatch independent Telegram command sync after disposal", async () => {
  const f = fixture(createTelegramChannelRuntime);
  await f.runtime.dispose();
  await (f.runtime as ReturnType<typeof createTelegramChannelRuntime>).syncCommands({
    id: "synthetic",
  } as BotConfig);
  expect(f.syncCommands).not.toHaveBeenCalled();
});
