import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { ZCODE_APP_CONFIG_SUBDIR_NAME, ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";
import { GEN_UI_OUTPUT_ROOT_ENV, getGenUiOutputDirectory } from "@zcode/shared/node";
import { getDataBaseDir, setDataBaseDir } from "../paths.js";
import { ZCodeAgentProcessManager } from "./zcodeAgentProcessManager.js";

it("passes the executor data directory to the spawned Agent over environment overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen-ui-spawn-"));
  const previous = getDataBaseDir();
  setDataBaseDir(root);
  const manager = new ZCodeAgentProcessManager({
    commandResolver: () => ({
      command: process.execPath,
      args: [
        "-e",
        `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const request=JSON.parse(line);
        process.stdout.write(JSON.stringify({id:request.id,result:process.env.${GEN_UI_OUTPUT_ROOT_ENV}})+'\\n');
      });`,
      ],
      env: { [GEN_UI_OUTPUT_ROOT_ENV]: join(root, "wrong-command-root") },
    }),
    resolveSpawnEnv: async () => ({ [GEN_UI_OUTPUT_ROOT_ENV]: join(root, "wrong-inherited-root") }),
  });
  try {
    const client = await manager.getClient({ workspacePath: root });
    const outputRoot = await client.request("session/list", {}, z.string());
    // 输出路径跟随产品数据目录常量，不能写死官方 .zcode 命名空间。
    expect(outputRoot).toBe(
      join(root, ZCODE_USER_DATA_DIR_NAME, ZCODE_APP_CONFIG_SUBDIR_NAME, "visualizations"),
    );
    const scope = { workspacePath: join(root, "project"), sessionId: "s" };
    expect(getGenUiOutputDirectory(outputRoot, scope)).toContain(outputRoot);
  } finally {
    await manager.disposeAllAndWait();
    setDataBaseDir(previous);
    await rm(root, { recursive: true, force: true });
  }
});
