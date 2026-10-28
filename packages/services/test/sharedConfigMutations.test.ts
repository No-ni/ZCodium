import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";

const observation = vi.hoisted(() => ({
  path: "",
  home: "",
  onLock: () => {},
  failure: "" as "" | "read" | "write" | "rename",
  writes: [] as Array<{ path: string; mode: unknown }>,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const matchesTarget = (path: unknown) =>
    String(path) === observation.path ||
    (dirname(String(path)) === dirname(observation.path) &&
      basename(String(path)).startsWith("config.json.") &&
      String(path).endsWith(".tmp"));
  return {
    ...original,
    readFile: (...args: Parameters<typeof original.readFile>) => {
      if (observation.failure === "read" && String(args[0]) === observation.path)
        throw Object.assign(new Error("fixture read failure"), { code: "EACCES" });
      return original.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof original.writeFile>) => {
      if (matchesTarget(args[0])) {
        const options = args[2];
        observation.writes.push({
          path: String(args[0]),
          mode: typeof options === "object" && options !== null ? options.mode : undefined,
        });
      }
      if (observation.failure === "write" && matchesTarget(args[0])) {
        await original.writeFile(args[0], String(args[1]).slice(0, 9), args[2]);
        throw Object.assign(new Error("fixture partial write failure"), { code: "ENOSPC" });
      }
      return original.writeFile(...args);
    },
    rename: (...args: Parameters<typeof original.rename>) => {
      if (observation.failure === "rename" && String(args[1]) === observation.path)
        throw Object.assign(new Error("fixture rename failure"), { code: "ENOSPC" });
      return original.rename(...args);
    },
  };
});
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
  observation.writes = [];
  vi.stubEnv("HOME", observation.home);
  vi.stubEnv("USERPROFILE", observation.home);
  vi.resetModules();
  await mkdir(dirname(observation.path), { recursive: true });
});

afterEach(async () => {
  observation.failure = "";
  observation.onLock = () => {};
  vi.unstubAllEnvs();
  await rm(observation.home, { recursive: true, force: true });
});

async function readConfig() {
  return JSON.parse(await readFile(observation.path, "utf8"));
}

async function importSettingsMcp() {
  const source = join(observation.home, ".claude", "settings.json");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(
    source,
    JSON.stringify({ mcpServers: { imported: { command: "fixture-import" } } }),
  );
  const { createSettingsSyncService } = await import("../src/settings-sync/settingsSyncService.js");
  const service = createSettingsSyncService({
    settingService: {} as import("../src/setting/setting.js").ISettingService,
  });
  return service.importSelected({
    selections: [
      { agent: "claudeCode", category: "mcpServers", sourceScope: "global", targetScope: "global" },
    ],
  });
}

async function createUserSkill() {
  const path = join(observation.home, ZCODE_USER_DATA_DIR_NAME, "skills", "sample", "SKILL.md");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "---\nname: sample\ndescription: sample skill\n---\nBody\n");
  const { createSkillsService } = await import("../src/skills/skillsService.js");
  const service = createSkillsService({ isDesktopRuntime: true });
  const skill = (await service.list({ workspacePath: observation.home })).skills.find(
    (item) => item.path === path,
  )!;
  expect(skill).toBeDefined();
  return { service, skill, path };
}

async function importSettingsPlugin() {
  const source = join(observation.home, ".claude", "plugins", "sample");
  const manifest = join(source, ".claude-plugin", "plugin.json");
  await mkdir(dirname(manifest), { recursive: true });
  await writeFile(manifest, JSON.stringify({ name: "sample", version: "1.0.0" }));
  const { createSettingsSyncService } = await import("../src/settings-sync/settingsSyncService.js");
  const service = createSettingsSyncService({
    settingService: {} as import("../src/setting/setting.js").ISettingService,
  });
  return service.importSelected({
    selections: [
      {
        agent: "claudeCode",
        category: "plugins",
        sourceScope: "global",
        targetScope: "global",
        importMode: "copy",
      },
    ],
  });
}

// 验证实际生产 helper 的写入选项，不能只靠 Windows 不支持的 POSIX mode 位断言。
it.each(["skill", "plugin", "settingsMcp"] as const)(
  "私有配置原子保存以 0600 创建临时文件并保留权限（%s）",
  async (owner) => {
    const initial = { provider: { model: "fixture-private" } };
    await writeFile(observation.path, JSON.stringify(initial), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(observation.path, 0o600);
    observation.writes = [];
    if (owner === "skill") {
      const { service, skill } = await createUserSkill();
      await service.setEnabled({
        workspacePath: observation.home,
        skillId: skill.id,
        enabled: false,
      });
    } else {
      const result = await (owner === "plugin" ? importSettingsPlugin() : importSettingsMcp());
      expect(result.successCount).toBe(1);
      expect(result.failedCount).toBe(0);
    }
    expect((await readConfig()).provider).toEqual(initial.provider);
    expect(observation.writes).toHaveLength(1);
    const [write] = observation.writes;
    expect(write!.path).not.toBe(observation.path);
    expect(dirname(write!.path)).toBe(dirname(observation.path));
    expect(write!.path).toMatch(/\.tmp$/);
    expect(write!.mode).toBe(0o600);
    if (process.platform !== "win32")
      expect((await stat(observation.path)).mode & 0o777).toBe(0o600);
    expect(
      (await readdir(dirname(observation.path))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  },
);

it("通用原子写入未指定 mode 时保持原系统默认权限语义", async () => {
  const { atomicWriteText } = await import("../src/fs/atomicFileUtils.js");
  const content = "fixture-default-mode";
  await atomicWriteText(observation.path, content, { useFileLock: false });
  expect(observation.writes).toHaveLength(1);
  expect(observation.writes[0]!.mode).toBeUndefined();
  expect(await readFile(observation.path, "utf8")).toBe(content);
  if (process.platform !== "win32") {
    expect((await stat(observation.path)).mode & 0o777).toBe(0o666 & ~process.umask());
  }
});

it("设置同步 MCP 导入等待目标锁并保留并发字段", async () => {
  await writeFile(observation.path, "{}");
  const fresh = {
    provider: { model: "latest" },
    mcp: { servers: { retained: { command: "latest" } } },
  };
  const result = await raceWithWriter(importSettingsMcp, fresh);
  expect(result.successCount).toBe(1);
  expect(await readConfig()).toEqual({
    ...fresh,
    mcp: { servers: { ...fresh.mcp.servers, imported: { command: "fixture-import" } } },
  });
});

it.each(["imported", "IMPORTED"])(
  "设置同步 MCP 导入锁内复查同名并返回真实 skipped（%s）",
  async (name) => {
    await writeFile(observation.path, "{}");
    const fresh = {
      provider: { model: "latest" },
      mcp: { servers: { [name]: { command: "latest" } } },
    };
    const result = await raceWithWriter(importSettingsMcp, fresh);
    expect(result.successCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.taskResults[0]?.mcpServerResults?.[0]).toMatchObject({
      status: "skipped",
      skipReason: "sameNameExists",
    });
    expect(await readConfig()).toEqual(fresh);
  },
);

it.each(["write", "rename"] as const)(
  "技能保存 %s 失败保留原始配置且清理临时文件",
  async (failure) => {
    const initial = {
      provider: { model: "latest" },
      mcp: { servers: { retained: { command: "fixture" } } },
    };
    const content = JSON.stringify(initial);
    await writeFile(observation.path, content);
    const { service, skill, path } = await createUserSkill();
    observation.failure = failure;
    await expect(
      service.setEnabled({ workspacePath: observation.home, skillId: skill.id, enabled: false }),
    ).rejects.toThrow(/fixture/);
    observation.failure = "";
    expect(await readFile(observation.path, "utf8")).toBe(content);
    expect(
      (await readdir(dirname(observation.path))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    await service.setEnabled({
      workspacePath: observation.home,
      skillId: skill.id,
      enabled: false,
    });
    expect(await readConfig()).toEqual({
      ...initial,
      skills: { [path.replaceAll("\\", "/")]: { enable: false } },
    });
  },
);

it.each(["{invalid", "[]"])("技能保存拒绝损坏或非对象目标配置（%s）", async (content) => {
  await writeFile(observation.path, "{}");
  const { service, skill } = await createUserSkill();
  await writeFile(observation.path, content);
  await expect(
    service.setEnabled({ workspacePath: observation.home, skillId: skill.id, enabled: false }),
  ).rejects.toThrow();
  expect(await readFile(observation.path, "utf8")).toBe(content);
});

it("技能保存读取权限失败时不覆盖目标配置", async () => {
  const content = JSON.stringify({ provider: { model: "latest" } });
  await writeFile(observation.path, content);
  const { service, skill } = await createUserSkill();
  observation.failure = "read";
  await expect(
    service.setEnabled({ workspacePath: observation.home, skillId: skill.id, enabled: false }),
  ).rejects.toThrow(/fixture read failure/);
  observation.failure = "";
  expect(await readFile(observation.path, "utf8")).toBe(content);
});

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

it.each(["native", "normalized", "both"])(
  "技能启用移除目标的所有等价路径开关，保留并发写入（%s）",
  async (style) => {
    const paths = ["alpha", "beta"].map((name) =>
      join(observation.home, ZCODE_USER_DATA_DIR_NAME, "skills", name, "SKILL.md"),
    );
    for (const path of paths) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "---\nname: sample\ndescription: sample skill\n---\nBody\n");
    }
    await writeFile(
      observation.path,
      JSON.stringify({
        skills: Object.fromEntries(paths.map((path) => [path, { enable: false }])),
      }),
    );
    const { createSkillsService } = await import("../src/skills/skillsService.js");
    const service = createSkillsService({ isDesktopRuntime: true });
    const { skills } = await service.list({ workspacePath: observation.home });
    const alpha = skills.find((skill) => skill.path === paths[0]);
    expect(alpha).toBeDefined();
    const normalizedAlpha = paths[0]!.replaceAll("\\", "/");
    const alphaKeys =
      style === "native"
        ? [paths[0]!]
        : style === "normalized"
          ? [normalizedAlpha]
          : [paths[0]!, normalizedAlpha];
    await raceWithWriter(
      () =>
        service.setEnabled({ workspacePath: observation.home, skillId: alpha!.id, enabled: true }),
      {
        provider: { model: "latest" },
        skills: {
          ...Object.fromEntries(alphaKeys.map((path) => [path, { enable: false }])),
          [paths[1]!]: { enable: false },
        },
      },
    );
    expect(await readConfig()).toEqual({
      provider: { model: "latest" },
      skills: { [paths[1]!]: { enable: false } },
    });
    expect(
      (await service.list({ workspacePath: observation.home })).skills.find(
        (skill) => skill.id === alpha!.id,
      )?.enabled,
    ).toBe(true);
  },
);

it("技能禁用合并原始 Windows key，重开后仍读取唯一规范 override", async () => {
  const path = join(observation.home, ZCODE_USER_DATA_DIR_NAME, "skills", "sample", "SKILL.md");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "---\nname: sample\ndescription: sample skill\n---\nBody\n");
  const { createSkillsService } = await import("../src/skills/skillsService.js");
  const service = createSkillsService({ isDesktopRuntime: true });
  const skill = (await service.list({ workspacePath: observation.home })).skills.find(
    (item) => item.path === path,
  )!;
  expect(skill).toBeDefined();
  await raceWithWriter(
    () =>
      service.setEnabled({ workspacePath: observation.home, skillId: skill.id, enabled: false }),
    { provider: { model: "latest" }, skills: { [path]: { enable: true } } },
  );
  expect(await readConfig()).toEqual({
    provider: { model: "latest" },
    skills: { [path.replaceAll("\\", "/")]: { enable: false } },
  });
  expect(
    (await service.list({ workspacePath: observation.home })).skills.find(
      (item) => item.id === skill.id,
    )?.enabled,
  ).toBe(false);
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
