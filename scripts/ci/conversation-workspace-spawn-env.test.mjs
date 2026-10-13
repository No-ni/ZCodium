/**
 * Host 侧 spawn 边界注入的对话根标记（**真实子进程**级验证）。
 *
 * 冻结两条只有真 spawn 才能验的性质：
 * 1. 值等于对话根且无 identity → 子进程看到对话根；
 * 2. 不适用（项目 workspace / 带 identity）→ 子进程看到**空串**（= CLI 侧"未启用"），
 *    而不是宿主 shell 或命令自带的同名变量。
 *
 * 第 2 条是"未注入 = 安全回滚"的最后一道防线：spawn env 以 `sanitizeZCodeRuntimeEnv(process.env)`
 * 起底，而该键不在清洗名单里，因此只要 spread 顺序写反（builder 被放到 `...spawnEnv` /
 * `...effectiveCommand.env` 之前），宿主变量就会原样下发。构造函数的单测
 * （conversation-workspace-env.test.mjs）看不到这一点，这里用真实 spawn 断言。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { tsImport } from "tsx/esm/api";
import { z } from "zod";

// paths.ts 在模块加载时捕获 ZCODE_DATA_BASE_DIR，所以必须在 import 之前指向临时数据根；
// 同时把宿主 shell 的"同名变量"也设成一个敌意值，验证它一定被覆盖。
// 两个变量都必须在**动态 import 完成的那一刻**还原（try/finally），不能等到文件级 after()：
// `--test-isolation=none` 下所有测试文件先被 import，文件级 after() 要等**全部**测试跑完才执行，
// 期间同进程的其它测试文件会看到本文件的临时数据根与敌意标记（D2 隔离泄漏）。
// 敌意标记在用例体内再设一次（下面的 try/finally），因为 spawn 的兜底 env 在 spawn 那一刻读
// `process.env`——这样既不把变量泄漏给别的文件，又保留"宿主 shell 同名变量必须被覆盖"这一层。
const dataBaseDir = await mkdtemp(join(tmpdir(), "zcode-spawn-env-data-"));
const inheritedDataBaseDir = process.env.ZCODE_DATA_BASE_DIR;
const inheritedMarkerKey = "ZCODE_CONVERSATION_WORKSPACE_ROOT";
const inheritedMarkerValue = join(dataBaseDir, "hostile-inherited");
let conversationWorkspaceEnvModule;
let agentProcessManagerModule;
let pathsModule;
process.env.ZCODE_DATA_BASE_DIR = dataBaseDir;
process.env[inheritedMarkerKey] = inheritedMarkerValue;
try {
  conversationWorkspaceEnvModule = await tsImport(
    "../../packages/shared/src/node/conversationWorkspaceEnv.ts",
    import.meta.url,
  );
  agentProcessManagerModule = await tsImport(
    "../../packages/services/src/zcode-agent/zcodeAgentProcessManager.ts",
    import.meta.url,
  );
  pathsModule = await tsImport("../../packages/services/src/paths.ts", import.meta.url);
} finally {
  if (inheritedDataBaseDir === undefined) {
    delete process.env.ZCODE_DATA_BASE_DIR;
  } else {
    process.env.ZCODE_DATA_BASE_DIR = inheritedDataBaseDir;
  }
  delete process.env[inheritedMarkerKey];
}
after(async () => {
  await rm(dataBaseDir, { recursive: true, force: true });
});

const { ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV, resolveConversationWorkspaceRoot } =
  conversationWorkspaceEnvModule;
const { ZCodeAgentProcessManager } = agentProcessManagerModule;
const { getConversationWorkspaceDir } = pathsModule;

function createFakeAgentManager() {
  return new ZCodeAgentProcessManager({
    commandResolver: () => ({
      command: process.execPath,
      args: [
        "-e",
        `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
          const request=JSON.parse(line);
          process.stdout.write(JSON.stringify({id:request.id,result:process.env.${ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV} ?? null})+'\\n');
        });`,
      ],
      env: { [ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV]: join(dataBaseDir, "hostile-command") },
    }),
    resolveSpawnEnv: async () => ({
      [ZCODE_CONVERSATION_WORKSPACE_ROOT_ENV]: join(dataBaseDir, "hostile-spawn-env"),
    }),
  });
}

test("spawn 注入：对话根 workspace 拿到对话根，项目 / identity workspace 拿到空串", async () => {
  const projectDir = join(dataBaseDir, "project");
  const conversationRoot = getConversationWorkspaceDir();
  await mkdir(projectDir, { recursive: true });
  await mkdir(conversationRoot, { recursive: true });

  // 宿主 shell 的同名变量只在用例体内存在（模块加载期那份已在 import 后还原）：spawn 的兜底 env
  // 在 spawn 那一刻读 process.env，因此这一层覆盖仍被真实检验，又不会泄漏给别的测试文件。
  process.env[inheritedMarkerKey] = inheritedMarkerValue;
  const manager = createFakeAgentManager();
  try {
    const readMarker = async (params) => {
      const client = await manager.getClient(params);
      return await client.request("session/list", {}, z.string());
    };
    // 对话根：唯一注入对话根值的场景。
    assert.equal(await readMarker({ workspacePath: conversationRoot }), conversationRoot);
    // 项目 workspace：不适用 → 空串（空串在 CLI 侧与缺席等价，都是"未启用"）。
    assert.equal(await readMarker({ workspacePath: projectDir }), "");
    assert.equal(resolveConversationWorkspaceRoot({ [inheritedMarkerKey]: "" }), undefined);
    // 带 identity 的 workspace：即使路径恰好等于对话根也不注入（远端/身份隔离优先）。
    assert.equal(
      await readMarker({
        workspaceIdentity: "remote-host:/srv/app",
        workspacePath: conversationRoot,
      }),
      "",
    );
  } finally {
    delete process.env[inheritedMarkerKey];
    await manager.disposeAllAndWait();
  }
});
