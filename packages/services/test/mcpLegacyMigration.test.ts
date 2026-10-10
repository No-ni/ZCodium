import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ZCODE_WORKSPACE_CONFIG_DIR_NAME } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import { createMcpSyncService } from "../src/mcp-sync/mcpSyncService.js";
import { loadCliMcpFromUserDirectory } from "../../desktop/src/main/mcpUserDirectory/index.js";

const observation = vi.hoisted(() => ({ path: "", onRead: () => {} }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      // 公共加载入口还会扫描用户目录；测试只访问自己的配置 fixture。
      if (
        typeof args[0] === "string" &&
        args[0] !== observation.path &&
        /(?:config|mcp)\.json$/.test(args[0])
      ) {
        throw Object.assign(new Error("fixture absent"), { code: "ENOENT" });
      }
      const result = await original.readFile(...args);
      if (args[0] === observation.path) observation.onRead();
      return result;
    },
  };
});

let directory: string;
afterEach(async () => {
  observation.path = "";
  observation.onRead = () => {};
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const [owner, load] of [
  ["Host", createMcpSyncService().loadMcpFromUserDirectory],
  ["Main", loadCliMcpFromUserDirectory],
] as const) {
  for (const action of ["update", "delete", "corrupt"] as const) {
    it(`${owner} 迁移等待锁期间 ${action} 不被旧快照覆盖`, async () => {
      directory = await mkdtemp(join(tmpdir(), "zcode-mcp-migration-"));
      const configDir = join(directory, ZCODE_WORKSPACE_CONFIG_DIR_NAME);
      const filePath = join(configDir, "config.json");
      await mkdir(configDir);
      await writeFile(filePath, JSON.stringify({ mcp: { servers: { old: { enable: false } } } }));
      const readCompleted = Promise.withResolvers<void>();
      const lockAcquired = Promise.withResolvers<void>();
      const releaseLock = Promise.withResolvers<void>();
      observation.path = filePath;
      observation.onRead = () => readCompleted.resolve();
      const writer = withFileLock(filePath, async () => {
        lockAcquired.resolve();
        await releaseLock.promise;
      });
      await lockAcquired.promise;
      let loading: ReturnType<typeof load> | undefined;
      try {
        loading = load({ workspacePath: directory });
        await readCompleted.promise;
        const fresh = {
          provider: { model: "new" },
          mcp: {
            servers: {
              old: { command: "new-command", enabled: true },
              added: { command: "added" },
            },
          },
        };
        if (action === "update") await writeFile(filePath, JSON.stringify(fresh));
        if (action === "delete") await rm(filePath);
        if (action === "corrupt") await writeFile(filePath, "{broken");
        vi.spyOn(console, "warn").mockImplementation(() => {});
        releaseLock.resolve();
        await writer;
        const result = await loading;
        const workspaceServers = result.servers.filter((s) => s.scope === "workspace");
        if (action === "update") {
          expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(fresh);
          expect(workspaceServers.map((s) => s.name).sort()).toEqual(["added", "old"]);
          expect(workspaceServers.find((s) => s.name === "old")?.enabled).toBe(true);
        }
        if (action === "delete") {
          await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
          expect(workspaceServers).toHaveLength(0);
        }
        if (action === "corrupt") {
          expect(await readFile(filePath, "utf8")).toBe("{broken");
          expect(workspaceServers.find((s) => s.name === "old")?.enabled).toBe(false);
        }
      } finally {
        releaseLock.resolve();
        await Promise.allSettled([writer, ...(loading ? [loading] : [])]);
      }
    });
  }
}
