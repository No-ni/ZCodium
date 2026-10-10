import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";

const observation = vi.hoisted(() => ({ path: "", home: "", onLock: () => {} }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => observation.home,
}));
vi.mock("@zcode/shared/node", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zcode/shared/node")>();
  return {
    ...original,
    withFileLock: (...args: Parameters<typeof original.withFileLock>) => {
      if (args[0] === observation.path) observation.onLock();
      return original.withFileLock(...args);
    },
  };
});

beforeEach(async () => {
  observation.home = await realpath(await mkdtemp(join(tmpdir(), "zcode-config-mutations-")));
  observation.path = join(observation.home, ZCODE_USER_DATA_DIR_NAME, "cli", "config.json");
  vi.stubEnv("HOME", observation.home);
  vi.stubEnv("USERPROFILE", observation.home);
  vi.resetModules();
  await mkdir(dirname(observation.path), { recursive: true });
});

afterEach(async () => {
  observation.onLock = () => {};
  vi.unstubAllEnvs();
  await rm(observation.home, { recursive: true, force: true });
});

async function readConfig() {
  return JSON.parse(await readFile(observation.path, "utf8"));
}

// 经公开入口走到真实锁；锁外旧值已经计算完时，让另一个写入方提交最新值。
async function raceWithWriter<T>(operation: () => Promise<T>, fresh: object): Promise<T> {
  const { withFileLock } =
    await vi.importActual<typeof import("@zcode/shared/node")>("@zcode/shared/node");
  const acquired = Promise.withResolvers<void>();
  const attempted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  observation.onLock = () => attempted.resolve();
  const writer = withFileLock(observation.path, async () => {
    acquired.resolve();
    await release.promise;
  });
  let running: Promise<T> | undefined;
  try {
    await acquired.promise;
    running = operation();
    await Promise.race([
      attempted.promise,
      running.then(() => {
        throw new Error("mutation completed without acquiring the config lock");
      }),
    ]);
    await writeFile(observation.path, JSON.stringify(fresh));
    release.resolve();
    await writer;
    return await running;
  } finally {
    release.resolve();
    await Promise.allSettled([writer, ...(running ? [running] : [])]);
  }
}

it("技能只修改目标路径，保留等待锁期间其他技能的开关", async () => {
  const paths = ["alpha", "beta"].map((name) =>
    join(observation.home, ZCODE_USER_DATA_DIR_NAME, "skills", name, "SKILL.md"),
  );
  for (const path of paths) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "---\nname: sample\ndescription: sample skill\n---\nBody\n");
  }
  await writeFile(
    observation.path,
    JSON.stringify({ skills: Object.fromEntries(paths.map((path) => [path, { enable: false }])) }),
  );
  const { createSkillsService } = await import("../src/skills/skillsService.js");
  const service = createSkillsService({ isDesktopRuntime: true });
  const { skills } = await service.list({ workspacePath: observation.home });
  const alpha = skills.find((skill) => skill.path === paths[0]);
  expect(alpha).toBeDefined();
  await raceWithWriter(
    () =>
      service.setEnabled({ workspacePath: observation.home, skillId: alpha!.id, enabled: true }),
    { provider: { model: "latest" }, skills: { [paths[0]!]: { enable: false } } },
  );
  expect(await readConfig()).toEqual({ provider: { model: "latest" } });
});

it.each([false, true])("命令改名保留并发更新的启用状态（原状态 %s）", async (enabled) => {
  const oldPath = join(observation.home, ZCODE_USER_DATA_DIR_NAME, "commands", "old.md");
  const nextPath = join(dirname(oldPath), "new.md");
  await mkdir(dirname(oldPath), { recursive: true });
  await writeFile(oldPath, "Old body\n");
  await writeFile(
    observation.path,
    JSON.stringify(enabled ? {} : { command: { [oldPath]: { enable: false } } }),
  );
  const { createCommandsService } = await import("../src/commands/commandsService.js");
  const service = createCommandsService();
  const fresh = {
    provider: { model: "latest" },
    ...(!enabled ? {} : { command: { [oldPath]: { enable: false } } }),
  };
  const { command } = await raceWithWriter(
    () =>
      service.updateCommandFile({
        commandId: "old",
        oldFilePath: oldPath,
        config: { name: "new", prompt: "New body" },
      }),
    fresh,
  );
  expect(command.enabled).toBe(!enabled);
  expect(await readConfig()).toEqual({
    provider: { model: "latest" },
    ...(!enabled ? {} : { command: { [nextPath]: { enable: false } } }),
  });
});

it.each(["shared", "SHARED"])("MCP 导入保留并发添加的同名 server（%s）", async (name) => {
  await writeFile(observation.path, "{}");
  const { createMcpSyncService } = await import("../src/mcp-sync/mcpSyncService.js");
  const service = createMcpSyncService();
  const fresh = {
    provider: { model: "latest" },
    mcp: { servers: { [name]: { command: "latest" } } },
  };
  const result = await raceWithWriter(
    () =>
      service.importMcpServers({
        localHomeDir: observation.home,
        servers: [
          {
            id: "shared",
            name: "shared",
            config: { command: "old" },
            enabled: true,
            source: "zcode",
            path: "source",
          },
        ],
      }),
    fresh,
  );
  expect(result.results).toEqual([{ name: "shared", status: "skipped", path: observation.path }]);
  expect(await readConfig()).toEqual(fresh);
});

for (const owner of ["Main", "Host"] as const) {
  it.each(["upsert", "delete"] as const)(`${owner} MCP %s 保留并发服务器修改`, async (action) => {
    await writeFile(
      observation.path,
      JSON.stringify({
        mcp: { servers: { target: { command: "old" }, other: { command: "old" } } },
      }),
    );
    const save =
      owner === "Main"
        ? (await import("../../desktop/src/main/mcpUserDirectory/index.js"))
            .saveCliMcpToUserDirectory
        : (await import("../src/mcp-sync/mcpSyncService.js")).createMcpSyncService()
            .saveMcpToUserDirectory;
    const fresh = {
      provider: { model: "latest" },
      mcp: {
        servers: {
          target: { command: "old" },
          other: { command: "latest", enabled: false },
          added: { command: "added" },
        },
      },
    };
    await raceWithWriter(
      () =>
        save({
          action,
          source: "zcodeagentmcp",
          name: "target",
          config: { command: "updated" },
        }),
      fresh,
    );
    expect(await readConfig()).toEqual({
      ...fresh,
      mcp: {
        servers: {
          other: fresh.mcp.servers.other,
          added: fresh.mcp.servers.added,
          ...(action === "upsert" ? { target: { command: "updated" } } : {}),
        },
      },
    });
  });
}
