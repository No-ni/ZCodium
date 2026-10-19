import { expect, it, vi } from "vitest";
import { createBotsService } from "../src/bots/botsService.js";

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  readState: vi.fn(),
  start: vi.fn(),
  acquire: vi.fn(),
  runtimes: [] as any[],
}));
vi.mock("../src/bots/repo.js", () => ({
  BotsRepo: class {
    readConfig = mocks.readConfig;
    writeConfig = mocks.writeConfig;
    readState = mocks.readState;
  },
}));
vi.mock("../src/bots/providers/feishuProvider.js", async (original) => ({
  ...(await original<object>()),
  startFeishuBotWebSocket: mocks.start,
}));
vi.mock("../src/bots/channelRuntime.js", async (original) => ({
  ...(await original<object>()),
  acquireFeishuWebSocketLock: mocks.acquire,
}));
vi.mock("../src/bots/feishuChannelRuntime.js", async (original) => {
  const actual = await original<typeof import("../src/bots/feishuChannelRuntime.js")>();
  return {
    createFeishuChannelRuntime: (...args: Parameters<typeof actual.createFeishuChannelRuntime>) => {
      const runtime = actual.createFeishuChannelRuntime(...args);
      mocks.runtimes.push(runtime);
      return runtime;
    },
  };
});

async function flush() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

it("does not restart providers when a pre-shutdown save completes late", async () => {
  const config = { version: 3, bots: [] };
  mocks.readConfig.mockResolvedValue(config);
  mocks.readState.mockResolvedValue({ version: 3, bots: {} });
  let completeWrite!: (value: unknown) => void;
  mocks.writeConfig.mockImplementation(
    () =>
      new Promise((resolve) => {
        completeWrite = resolve;
      }),
  );
  const release = vi.fn(async () => {});
  mocks.acquire.mockResolvedValue({ release });
  const close = vi.fn();
  let actualSignal: AbortSignal | undefined;
  mocks.start.mockImplementation(async ({ signal }) => {
    actualSignal = signal;
    let finish!: () => void;
    const terminated = new Promise<void>((resolve) => {
      finish = resolve;
    });
    close.mockImplementation(finish);
    return { close, terminated };
  });
  const bots = createBotsService({
    credentialService: { load: async () => "synthetic-value" },
    runStartupBackgroundTasks: true,
  } as unknown as Parameters<typeof createBotsService>[0]);
  try {
    await flush();
    expect(mocks.start).not.toHaveBeenCalled();
    const saved = {
      version: 3,
      bots: [
        {
          id: "synthetic",
          name: "synthetic",
          provider: "feishu",
          enabled: true,
          credentialRef: "synthetic-ref",
          feishuAppId: "cli_synthetic",
          allowedWorkspaces: [],
        },
      ],
    };
    const saving = bots.saveConfig(saved as any);
    await flush();
    await bots.disposeAllAndWait();
    completeWrite(saved);
    await saving;
    await flush();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(actualSignal).toBeUndefined();
    await bots.disposeAllAndWait();
    expect(actualSignal).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  } finally {
    for (const runtime of mocks.runtimes) await runtime.dispose();
    await bots.disposeAllAndWait();
  }
  expect(close).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
});
