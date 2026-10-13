/* eslint-disable max-lines -- 见文件头注释：本文件只覆盖「技能发现根 = 工作区键路径」这一条规则，
   用例之间共享同一份临时工作区 fixture 与同一份 tsImport 装载。 */
/**
 * 对话会话里「工作区级 skills 仍被 Agent 读到」的回归测试（规格规则 9 / 验收 7）。
 *
 * 为什么必须单独钉住：会话的执行 cwd 是 `<对话根>/<日期>/<id8>`，而技能是**工作区级**资产——
 * `resolveDefaultSkillRoots(workingDirectory)` 在找不到 `.git` 时只取传入目录本身，所以技能发现根
 * 必须显式用工作区键路径（对话根）。用执行 cwd 会让 `<对话根>/.zcodium/skills/**` 静默消失：
 * 设置页看得见、模型看不见。这条链只有「建应用 → 首个 turn 初始化 context」时才会跑到，进程级
 * E2E 不请求模型，所以用真实适配器 + 假 runtime 单测钉住。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { NodeSkillAdapter } = await tsImport(
  "../../apps/zcode-cli/packages/adapters/src/skills/index.ts",
  import.meta.url,
);
const { discoverSkillsForContext } = await tsImport(
  "../../apps/zcode-cli/packages/core/src/runtime/methods/context.ts",
  import.meta.url,
);

const SKILL_NAME = "conversation-workspace-demo";

async function withWorkspace(fn) {
  const dataRoot = await mkdtemp(join(tmpdir(), "zcode-skill-scope-"));
  try {
    // 布局照真实形态：对话根 `workspace/default`，会话目录在它之下。
    const conversationRoot = join(dataRoot, ".zcodium", "workspace", "default");
    const sessionDir = join(conversationRoot, "2026-10-11", "a1b2c3d4");
    const home = join(dataRoot, "home");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(join(conversationRoot, ".zcodium", "skills", SKILL_NAME), { recursive: true });
    await writeFile(
      join(conversationRoot, ".zcodium", "skills", SKILL_NAME, "SKILL.md"),
      [
        "---",
        `name: ${SKILL_NAME}`,
        "description: 对话会话必须能看见工作区级技能",
        "---",
        "",
        "# demo",
        "",
      ].join("\n"),
    );
    await fn({ conversationRoot, dataRoot, home, sessionDir });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function createRuntimeFixture({ home, sessionDir, conversationRoot, seenRequests }) {
  const skillPort = new NodeSkillAdapter({ homeDirectory: home });
  return {
    skillPort: {
      discoverSkills: async (request, options) => {
        seenRequests.push(request);
        return await skillPort.discoverSkills(request, options);
      },
    },
    // 工作区级根的唯一来源是 `config.workspacePath`（协议会话恒有它 = 对话根；
    // CLI/TUI 独立运行没有它时，`workspaceLevelRootOf` 按**当前执行 cwd** 解析——
    // 那正是改动前这些读点的行为）。只给 `workspaceScopeRoot` 的替身不算声明过身份。
    config: { workspacePath: conversationRoot },
    // 执行 cwd = 会话目录（新行为的真实形态）。
    workingDirectory: sessionDir,
    workspaceRoot: sessionDir,
    // 工作区键路径 = 对话根（与 `config.workspacePath` 同值；projectID/项目记忆根读它，
    // 不随 Bash cd 漂移）。
    workspaceScopeRoot: conversationRoot,
  };
}

/** CLI/TUI 独立运行：没有 `config.workspacePath`，工作区级根必须跟随当前执行 cwd。 */
function createCliRuntimeFixture({ home, sessionDir, seenRequests }) {
  const fixture = createRuntimeFixture({
    conversationRoot: sessionDir,
    home,
    seenRequests,
    sessionDir,
  });
  return { ...fixture, config: {}, workspaceScopeRoot: sessionDir };
}

test("技能发现根用工作区键路径：对话会话仍能看见 <对话根>/.zcodium/skills", async () => {
  await withWorkspace(async ({ conversationRoot, home, sessionDir }) => {
    const seenRequests = [];
    const runtime = createRuntimeFixture({ conversationRoot, home, seenRequests, sessionDir });
    const outcome = await discoverSkillsForContext.call(runtime, { traceId: "trace-ci" });

    assert.ok(outcome, "配了 skillPort 就必须返回发现结果");
    const names = outcome.skills.map((skill) => skill.name);
    assert.ok(
      names.includes(SKILL_NAME),
      `对话会话必须看见工作区级技能（发现根应为对话根），实际技能: ${JSON.stringify(names)}；` +
        `请求的 workingDirectory=${String(seenRequests.at(-1)?.workingDirectory)}`,
    );
  });
});

test("技能发现请求的 workingDirectory 必须是工作区键路径而不是执行 cwd", async () => {
  await withWorkspace(async ({ conversationRoot, home, sessionDir }) => {
    const seenRequests = [];
    const runtime = createRuntimeFixture({ conversationRoot, home, seenRequests, sessionDir });
    await discoverSkillsForContext.call(runtime, { traceId: "trace-ci" });

    assert.equal(seenRequests.length, 1, "每次 context 初始化只发现一次技能");
    assert.equal(
      seenRequests[0].workingDirectory,
      conversationRoot,
      "技能发现根必须是工作区键路径（对话根），用执行 cwd 会让工作区技能静默失效",
    );
    assert.notEqual(seenRequests[0].workingDirectory, sessionDir);
  });
});

test("CLI/TUI 没有 config.workspacePath 时，技能发现根跟随当前执行 cwd（不冻结在启动目录）", async () => {
  await withWorkspace(async ({ home, sessionDir }) => {
    const seenRequests = [];
    const runtime = createCliRuntimeFixture({ home, seenRequests, sessionDir });
    await discoverSkillsForContext.call(runtime, { traceId: "trace-ci" });
    assert.equal(
      seenRequests[0]?.workingDirectory,
      sessionDir,
      "没有声明工作区键路径时，工作区级根就是执行 cwd（改动前的行为，cd 之后要跟着走）",
    );
  });
});
