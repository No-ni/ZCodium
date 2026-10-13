import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

// 冻结「工作区键路径 / 工作区级根 / 执行 cwd」三者的分工（第四轮对抗式 review 的两个真回归）：
// - `workspaceScopeRootOf`：项目身份、项目记忆根、持久化 agent memory、gen-ui 作用域。
//   **不随 Bash `cd` 漂移**，改动前用 `workspaceRoot`，CLI/TUI 的替身只给执行边界时回落 `workspaceRoot`。
// - `workspaceLevelRootOf`：`.zcodium` 下的工作区级产物（workflow 定义与草稿、skills 发现、
//   MCP 工程配置）**以及 MCP 的连接身份**（`methods/mcp.ts` 把同一个值同时当池键与 stdio cwd）。
//   有 `config.workspacePath` 时就是工作区键路径（对话会话 = 对话根，不能
//   按会话各建一份）；CLI/TUI 没有它时必须**跟随当前执行 cwd**（改动前这些读点用的就是
//   `workingDirectory`，冻结会让 `cd sub` 之后的草稿/技能根落回启动目录）。
// - Hook 的**执行** cwd 与 `CLAUDE_PROJECT_DIR`：模型当前 cwd（`getWorkingDirectory` /
//   `this.workingDirectory`），不是工作区键路径——hook 脚本作用在模型正在编辑的目录上。
//   工作区级的是 hooks 的**发现与信任**根。
// 见 docs/specs/conversation-session-workspace.md 规则 9。
const { workspaceLevelRootOf, workspaceScopeRootOf } = await tsImport(
  "../../apps/zcode-cli/packages/core/src/runtime/helpers/workspace-scope.ts",
  import.meta.url,
);
const {
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPermissionRequestHooks,
  runPreToolUseHooks,
} = await tsImport(
  "../../apps/zcode-cli/packages/core/src/tool/executor/hook-flow.ts",
  import.meta.url,
);
const { runSessionStartHooks, runStopHooks, runUserPromptSubmitHooks } = await tsImport(
  "../../apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts",
  import.meta.url,
);
const { startSavedWorkflowRun } = await tsImport(
  "../../apps/zcode-cli/packages/core/src/runtime/methods/dynamic-workflow-run-start.ts",
  import.meta.url,
);

const CONVERSATION_ROOT = "/home/dev/.zcodium/workspace/default";
const SESSION_DIR = `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4`;
const TRACE = { traceId: "trace-1", turnId: "turn-1" };

test("workspaceScopeRootOf：身份优先；空串与缺席同义并回落 workspaceRoot（不随 cd 漂移）", () => {
  assert.equal(
    workspaceScopeRootOf({ workspaceScopeRoot: CONVERSATION_ROOT, workspaceRoot: SESSION_DIR }),
    CONVERSATION_ROOT,
  );
  // CLI/TUI 替身（只建模执行边界）：改动前就是 workspaceRoot。
  assert.equal(workspaceScopeRootOf({ workspaceRoot: SESSION_DIR }), SESSION_DIR);
  // 畸形空串不能一路走到 resolve("") 变成进程 cwd。
  assert.equal(
    workspaceScopeRootOf({ workspaceScopeRoot: "", workspaceRoot: SESSION_DIR }),
    SESSION_DIR,
  );
});

test("workspaceLevelRootOf：有 workspacePath 就用它（对话会话含 cd 之后），CLI/TUI 跟随执行 cwd", () => {
  // 协议会话 / 项目工作区：身份不随执行 cwd 漂移——对话会话的工作区级产物必须落在对话根，
  // 否则每个会话各建一份 workflow 定义与草稿，等于功能失效。
  assert.equal(
    workspaceLevelRootOf({
      config: { workspacePath: CONVERSATION_ROOT },
      workingDirectory: SESSION_DIR,
      workspaceRoot: SESSION_DIR,
    }),
    CONVERSATION_ROOT,
  );
  // CLI/TUI 独立运行（没有 workspacePath）：必须跟随**当前**执行 cwd，`cd` 之后不回退。
  assert.equal(
    workspaceLevelRootOf({
      config: {},
      workingDirectory: "/proj/sub",
      workspaceRoot: "/proj",
    }),
    "/proj/sub",
  );
  assert.equal(
    workspaceLevelRootOf({
      config: {},
      workingDirectory: "/proj",
      workspaceRoot: "/proj",
    }),
    "/proj",
  );
  // 空串声明的 workspacePath 与缺席同义（否则会拿到空根，join 出相对路径）。
  assert.equal(
    workspaceLevelRootOf({
      config: { workspacePath: "" },
      workingDirectory: "/proj/sub",
      workspaceRoot: "/proj",
    }),
    "/proj/sub",
  );
  // 执行 cwd 也拿不到时（部分建模的替身）回落 workspaceRoot。
  assert.equal(
    workspaceLevelRootOf({ config: {}, workingDirectory: "", workspaceRoot: "/proj" }),
    "/proj",
  );
});

/** 只捕获 hook 输入的最小替身：cwd 与发现/信任根故意不同，用错一个就会红。 */
function createHookStub() {
  const captured = [];
  const hookRunner = {
    async run(input) {
      captured.push(input);
      return { additionalContexts: [] };
    },
  };
  return {
    captured,
    deps: {
      getMode: () => "build",
      getWorkingDirectory: () => SESSION_DIR,
      getWorkspaceScopeRoot: () => CONVERSATION_ROOT,
      hookRunner,
      sessionId: "sess_a1b2c3d4-0000-4000-8000-000000000000",
      turnId: "turn-1",
    },
  };
}

const TOOL_CALL = { id: "call-1", name: "Write" };
const ENTRY = { metadata: { riskLevel: "medium", sideEffectScope: "workspace" } };

test("四个 hook 事件点的执行 cwd 都是模型当前 cwd，不是工作区键路径", async () => {
  const stub = createHookStub();
  await runPreToolUseHooks(stub.deps, TOOL_CALL, { file_path: "a.txt" }, ENTRY, "build", TRACE);
  await runPermissionRequestHooks(
    stub.deps,
    TOOL_CALL,
    { file_path: "a.txt" },
    "req-1",
    { decision: "ask", allowed: false, riskLevel: "medium", sideEffectScope: "workspace" },
    "build",
    TRACE,
  );
  await runPostToolUseHooks(stub.deps, TOOL_CALL, { file_path: "a.txt" }, "ok", undefined, TRACE);
  await runPostToolUseFailureHooks(
    stub.deps,
    TOOL_CALL,
    { file_path: "a.txt" },
    new Error("boom"),
    TRACE,
  );

  assert.deepEqual(
    stub.captured.map((input) => input.hookEventName),
    ["PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"],
  );
  for (const input of stub.captured) {
    assert.equal(input.cwd, SESSION_DIR);
    // 夹具里两个根不同：这条断言就是「别再用工作区键路径」的回归护栏。
    assert.notEqual(input.cwd, CONVERSATION_ROOT);
  }
});

/** 生命周期 hook 的替身：`this.workingDirectory` 是执行 cwd，`workspaceScopeRoot` 是身份。 */
function createLifecycleStub() {
  const captured = [];
  return {
    captured,
    runtime: {
      config: { agentName: "zcode" },
      getMode: () => "build",
      getSessionModelSelection: () => undefined,
      hookRunner: {
        async run(input) {
          captured.push(input);
          return { additionalContexts: [] };
        },
      },
      sessionId: "sess_a1b2c3d4-0000-4000-8000-000000000000",
      sessionStartHookRan: false,
      workingDirectory: SESSION_DIR,
      workspaceRoot: SESSION_DIR,
      workspaceScopeRoot: CONVERSATION_ROOT,
    },
  };
}

test("SessionStart / UserPromptSubmit / Stop 的执行 cwd 也是模型当前 cwd", async () => {
  const stub = createLifecycleStub();
  await runSessionStartHooks.call(stub.runtime, "startup", TRACE);
  await runUserPromptSubmitHooks.call(stub.runtime, "hello", undefined, TRACE);
  await runStopHooks.call(stub.runtime, "done", 1, TRACE);

  assert.deepEqual(
    stub.captured.map((input) => input.hookEventName),
    ["SessionStart", "UserPromptSubmit", "Stop"],
  );
  for (const input of stub.captured) {
    assert.equal(input.cwd, SESSION_DIR);
    assert.notEqual(input.cwd, CONVERSATION_ROOT);
  }
});

/**
 * 中枢直接启动已保存工作流的**解析根**（第五轮修复的残留）。
 *
 * 修复前这里用的是 `workspaceScopeRootOf`（冻结的工作区键路径），而同一次「按名字找一份定义」
 * 在工具侧（CreateWorkflow 的 `saved` 来源、SaveWorkflow 的落点、ListSavedWorkflows 的枚举）
 * 用的是 `workspaceLevelRootOf`（有 workspacePath 时同值，CLI/TUI 没有它时跟随**当前**执行 cwd）。
 * 两者在协议会话里不可区分，但 CLI/TUI 里 `cd sub` 之后会对同一个名字给出相反结论：
 * 工具在 `sub/.zcodium/workflows` 找到并运行，中枢却按启动目录找不到。改动前本函数用的就是
 * `this.workingDirectory`（当前执行 cwd），因此这里必须跟随执行 cwd。
 *
 * 判据落在 `not_found` 的两种 message 上：文件在但读不出来（"could not be read" + 绝对路径）
 * 与文件不存在（"No project workflow named"）。把定义故意放在**执行 cwd** 下并写成坏文件——
 * 用冻结根就找不到它，返回后者；只有按执行 cwd 找才返回前者。两条分支都在任何副作用之前返回
 * （无 run / 无消息 / 无端口），所以替身只需要这几个字段。
 */
test("中枢启动已保存工作流的解析根跟随当前执行 cwd（与 CreateWorkflow 同根）", async () => {
  const frozenRoot = await mkdtemp(join(tmpdir(), "zcode-workflow-root-"));
  try {
    // CLI/TUI：没有 config.workspacePath，冻结边界 = 启动时的执行 cwd（frozenRoot）。
    const liveCwd = join(frozenRoot, "sub");
    const workflowsDir = join(liveCwd, ".zcodium", "workflows");
    const definitionPath = join(workflowsDir, "demo.dwf.ts");
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(definitionPath, "not a saved workflow\n", "utf8");

    const result = await startSavedWorkflowRun.call(
      {
        config: {},
        hasActiveOrQueuedTurnWork: () => false,
        rootTraceContext: TRACE,
        workingDirectory: liveCwd,
        workspaceRoot: frozenRoot,
        workspaceScopeRoot: frozenRoot,
      },
      { name: "demo", scope: "project" },
    );

    assert.equal(result.ok, false);
    const message = result.message ?? "";
    assert.match(message, /could not be read/u);
    assert.ok(
      message.includes(definitionPath),
      `解析根必须是当前执行 cwd 下的定义，实际 message: ${message}`,
    );
  } finally {
    await rm(frozenRoot, { force: true, recursive: true });
  }
});
