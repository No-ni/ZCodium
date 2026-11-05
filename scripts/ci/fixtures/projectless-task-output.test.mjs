import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { getGenUiOutputDirectory } from "../../../packages/shared/src/node/genUiPaths.ts";
import { buildAgentConversationWorkspaceEnv } from "../../../packages/services/src/runtime-tools/agentProxyEnv.ts";
import { readGenUiDocument } from "../../../packages/services/src/gen-ui/adapters/files.ts";
import { resolveGenUiOutputDirectory } from "../../../apps/zcode-cli/packages/core/src/runtime/helpers/gen-ui-output.ts";
import { assertProjectPath, createProjectTestSymlink } from "../project-test-sandbox.mjs";
import { resolveE2EStorageRoot } from "../../../packages/desktop/test/e2e/helpers/e2e-runtime-paths.ts";

const UUID = "a1b2c3d4-1234-4321-8123-123456789abc";
const marker = "ZCODE_CONVERSATION_WORKSPACE_ROOT";
const base = await assertProjectPath(join(process.env.PROJECT_TEST_SANDBOX_ROOT, "task-output"));
const defaultRoot = join(base, "workspace", "default");
const globalRoot = join(base, "global", "visualizations");

test("PTW01/03: Desktop runner 配置播种与路径 helper 共用当前产品数据根", async () => {
  const path = "packages/desktop/wdio.conf.ts";
  const text = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const roots = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "E2E_STORAGE_ROOT")
      roots.push(node.initializer.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(roots.length, 1);
  const home = join(base, "e2e-home");
  const runnerRoot = new Function(
    "resolve",
    "resolveE2EStorageRoot",
    "E2E_HOME_DIR",
    `return ${roots[0]};`,
  )(resolve, resolveE2EStorageRoot, home);
  assert.equal(runnerRoot, resolveE2EStorageRoot(home));
});

for (const name of [`draft-${UUID}`, `1793846400000-${UUID}`]) {
  test(`PTW04: ${name} 初始 cwd 使用任务内 visualizations，Host marker 同源`, () => {
    const workspacePath = join(dirname(defaultRoot), name);
    const scope = { workspacePath, sessionId: "session-a" };
    assert.equal(
      getGenUiOutputDirectory(globalRoot, scope, {
        conversationWorkspaceRoot: defaultRoot,
        executionWorkspacePath: workspacePath,
      }),
      join(workspacePath, "visualizations"),
    );
    assert.deepEqual(buildAgentConversationWorkspaceEnv(workspacePath, undefined, defaultRoot), {
      [marker]: defaultRoot,
    });
    assert.equal(
      resolveGenUiOutputDirectory({
        sessionId: scope.sessionId,
        workspaceRoot: workspacePath,
        config: {
          workspacePath,
          genUiOutputRoot: globalRoot,
          presentationSurface: "zcode_desktop",
          conversationWorkspaceRoot: defaultRoot,
        },
      }),
      join(workspacePath, "visualizations"),
    );
  });
}

test("PTW06: 初始 cwd 在任务内的派生会话保留继承目录，根外继承使用全局输出", () => {
  const workspacePath = join(dirname(defaultRoot), `draft-${UUID}`);
  const scope = { workspacePath, sessionId: "child" };
  for (const executionWorkspacePath of [workspacePath, join(workspacePath, "child")])
    assert.equal(
      getGenUiOutputDirectory(globalRoot, scope, {
        conversationWorkspaceRoot: defaultRoot,
        executionWorkspacePath,
      }),
      join(executionWorkspacePath, "visualizations"),
    );
  assert.equal(
    getGenUiOutputDirectory(globalRoot, scope, {
      conversationWorkspaceRoot: defaultRoot,
      executionWorkspacePath: join(base, "external"),
    }),
    getGenUiOutputDirectory(globalRoot, scope),
  );
});

test("PTW05: 项目、任务后代、同名前缀及外部同名目录不获得任务本地输出", () => {
  for (const workspacePath of [
    join(dirname(defaultRoot), UUID),
    join(dirname(defaultRoot), `draft-${UUID}`, "child"),
    join(dirname(defaultRoot), `draft-${UUID}-extra`),
    join(dirname(defaultRoot), "draft-invalid"),
    join(base, "external", `draft-${UUID}`),
  ]) {
    const scope = { workspacePath, sessionId: "session-a" };
    assert.deepEqual(buildAgentConversationWorkspaceEnv(workspacePath, undefined, defaultRoot), {
      [marker]: "",
    });
    assert.equal(
      getGenUiOutputDirectory(globalRoot, scope, {
        conversationWorkspaceRoot: defaultRoot,
        executionWorkspacePath: workspacePath,
      }),
      getGenUiOutputDirectory(globalRoot, scope),
    );
  }
});

test("PTW05: remote identity 优先；同一路径的规范写法仍能识别；相对 cwd 被拒绝", () => {
  const workspacePath = join(dirname(defaultRoot), `draft-${UUID}`);
  const remote = { workspacePath, workspaceIdentity: "remote:fixture", sessionId: "session-a" };
  const conversation = {
    conversationWorkspaceRoot: defaultRoot,
    executionWorkspacePath: workspacePath,
  };
  assert.deepEqual(
    buildAgentConversationWorkspaceEnv(workspacePath, remote.workspaceIdentity, defaultRoot),
    {
      [marker]: "",
    },
  );
  assert.equal(
    getGenUiOutputDirectory(globalRoot, remote, conversation),
    getGenUiOutputDirectory(globalRoot, remote),
  );
  assert.deepEqual(
    buildAgentConversationWorkspaceEnv(join(workspacePath, "."), "  ", `${defaultRoot}/`),
    {
      [marker]: `${defaultRoot}/`,
    },
  );
  assert.throws(
    () =>
      getGenUiOutputDirectory(
        globalRoot,
        { ...remote, workspaceIdentity: undefined },
        {
          ...conversation,
          executionWorkspacePath: "relative",
        },
      ),
    /absolute/,
  );
});

async function fixture() {
  const root = await assertProjectPath(join(base, randomUUID()));
  const conversationWorkspaceRoot = join(root, "workspace", "default");
  const workspacePath = join(dirname(conversationWorkspaceRoot), `draft-${randomUUID()}`);
  const sibling = join(dirname(conversationWorkspaceRoot), `draft-${randomUUID()}`);
  const outputRoot = join(root, "global", "visualizations");
  const scope = { workspacePath, sessionId: "session-a" };
  const path = join(workspacePath, "visualizations", "chart.html");
  for (const dir of [dirname(path), sibling, outputRoot]) await mkdir(dir, { recursive: true });
  await writeFile(path, "<div>task-owned</div>");
  const queries = [];
  const conversation = {
    conversationWorkspaceRoot,
    resolveSessionWorkspacePath: async (target) => {
      queries.push(target);
      if (target.sessionId !== scope.sessionId) throw new Error("Gen UI session not found");
      return workspacePath;
    },
  };
  return { root, scope, path, sibling, outputRoot, conversation, queries };
}

test("PTW04: 真实 task fragment 由可信 session 查询授权，旧全局 fragment 仍可读取", async () => {
  const f = await fixture();
  assert.equal(
    (await readGenUiDocument({ ...f.scope, path: f.path }, f.outputRoot, f.conversation)).html,
    "<div>task-owned</div>",
  );
  assert.deepEqual(f.queries, [{ ...f.scope, workspaceIdentity: undefined }]);
  const old = join(getGenUiOutputDirectory(f.outputRoot, f.scope), "old.html");
  await mkdir(dirname(old), { recursive: true });
  await writeFile(old, "<div>legacy-global</div>");
  assert.equal(
    (await readGenUiDocument({ ...f.scope, path: old }, f.outputRoot, f.conversation)).html,
    "<div>legacy-global</div>",
  );
  assert.equal(f.queries.length, 1, "读取旧全局路径不能被新本地查询依赖阻断");
});

test("PTW05: 缺席/错误 session、sibling cwd 和 Renderer 的任意 sibling 路径均被拒绝", async () => {
  const f = await fixture();
  const target = { ...f.scope, path: f.path };
  await assert.rejects(
    readGenUiDocument({ ...target, sessionId: "missing" }, f.outputRoot, f.conversation),
    /not found/,
  );
  for (const executionPath of [undefined, f.sibling, join(f.root, "external")])
    await assert.rejects(
      readGenUiDocument(target, f.outputRoot, {
        ...f.conversation,
        resolveSessionWorkspacePath: async () => executionPath,
      }),
      /session output/,
    );
  const siblingFile = join(f.sibling, "visualizations", "chart.html");
  await mkdir(dirname(siblingFile), { recursive: true });
  await writeFile(siblingFile, "<div>other task</div>");
  await assert.rejects(
    readGenUiDocument({ ...target, path: siblingFile }, f.outputRoot, f.conversation),
    /session output/,
  );
  await assert.rejects(
    readGenUiDocument(
      { ...target, workspaceIdentity: "remote:fixture" },
      f.outputRoot,
      f.conversation,
    ),
    /session output/,
  );
});

test("PTW05: task 根/文件中的真实链接不能成为读取授权根", async () => {
  const f = await fixture();
  const fileLink = join(dirname(f.path), "link.html");
  await createProjectTestSymlink(f.path, fileLink, "file");
  await assert.rejects(
    readGenUiDocument({ ...f.scope, path: fileLink }, f.outputRoot, f.conversation),
    /symbolic links/,
  );
  const rootLink = join(dirname(f.scope.workspacePath), `draft-${randomUUID()}`);
  await createProjectTestSymlink(f.scope.workspacePath, rootLink, "dir");
  await assert.rejects(
    readGenUiDocument(
      {
        workspacePath: rootLink,
        sessionId: "session-a",
        path: join(rootLink, "visualizations", "chart.html"),
      },
      f.outputRoot,
      {
        ...f.conversation,
        resolveSessionWorkspacePath: async () => rootLink,
      },
    ),
    /symbolic links/,
  );
});

test("PTW05: 本地 task 读取仍拒绝整页 HTML、超限文件与相对输入", async () => {
  const f = await fixture();
  const target = { ...f.scope, path: f.path };
  await writeFile(f.path, "<!doctype html><html><body>bad</body></html>");
  await assert.rejects(readGenUiDocument(target, f.outputRoot, f.conversation), /fragment/);
  await writeFile(f.path, "x".repeat(5_000_001));
  await assert.rejects(readGenUiDocument(target, f.outputRoot, f.conversation), /5 MB/);
  await assert.rejects(
    readGenUiDocument({ ...target, path: "relative.html" }, f.outputRoot, f.conversation),
    /path/,
  );
});

test("PTW04/06: 旧 default 的会话 cwd 与根外继承保持既有输出合同", async () => {
  const f = await fixture();
  const workspacePath = f.conversation.conversationWorkspaceRoot;
  const executionWorkspacePath = join(workspacePath, "2026-11-05", "a1b2c3d4");
  const scope = { workspacePath, sessionId: "legacy" };
  const directory = getGenUiOutputDirectory(f.outputRoot, scope, {
    conversationWorkspaceRoot: workspacePath,
    executionWorkspacePath,
  });
  assert.equal(directory, join(executionWorkspacePath, "visualizations"));
  await mkdir(directory, { recursive: true });
  const path = join(directory, "old.html");
  await writeFile(path, "<div>legacy-default</div>");
  assert.equal(
    (
      await readGenUiDocument({ ...scope, path }, f.outputRoot, {
        conversationWorkspaceRoot: workspacePath,
        resolveSessionWorkspacePath: async () => executionWorkspacePath,
      })
    ).html,
    "<div>legacy-default</div>",
  );
  assert.equal(
    getGenUiOutputDirectory(f.outputRoot, scope, {
      conversationWorkspaceRoot: workspacePath,
      executionWorkspacePath: resolve(f.root, "external"),
    }),
    getGenUiOutputDirectory(f.outputRoot, scope),
  );
});

// 驱动 Host 装配中的真实可信查询 callback，避免只验证适配器的模拟授权端口。
async function loadTrustedSessionResolver(listSessions) {
  const path = "packages/services/src/node.ts";
  const text = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const callbacks = [];
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "resolveSessionWorkspacePath"
    )
      callbacks.push(node.initializer.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(callbacks.length, 1, "Host 必须只有一条 Gen UI 会话授权查询路径");
  const { outputText } = ts.transpileModule(`const callback = ${callbacks[0]};`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return new Function("zcodeAgentService", `${outputText}\nreturn callback;`)({ listSessions });
}

test("PTW04/06: Host 精确查询同 scope 的持久会话后才允许原 cwd 或绑定 task 路径", async () => {
  const workspacePath = join(dirname(defaultRoot), `draft-${UUID}`);
  const scope = { workspacePath, sessionId: "session-a", workspaceIdentity: "  " };
  const workspace = { workspacePath, workspaceKey: workspacePath };
  for (const executionWorkspacePath of [undefined, join(workspacePath, "child")]) {
    const queries = [];
    const resolver = await loadTrustedSessionResolver(async (query) => {
      queries.push(query);
      return [{ sessionId: scope.sessionId, workspace, executionWorkspacePath }];
    });
    assert.equal(await resolver(scope), executionWorkspacePath ?? workspacePath);
    assert.deepEqual(queries, [{ ...scope, sessionIds: [scope.sessionId] }]);
  }
});

test("PTW05: Host 缺席会话、路径或 identity 不匹配与查询失败均不能授权 task 文件", async () => {
  const workspacePath = join(dirname(defaultRoot), `draft-${UUID}`);
  const scope = { workspacePath, sessionId: "session-a" };
  const session = {
    sessionId: scope.sessionId,
    workspace: { workspacePath, workspaceKey: workspacePath },
  };
  for (const rows of [
    [],
    [{ ...session, sessionId: "other-session" }],
    [{ ...session, workspace: { ...session.workspace, workspacePath: join(base, "other-task") } }],
    [{ ...session, workspace: { ...session.workspace, workspaceKey: "remote:other" } }],
  ]) {
    const resolver = await loadTrustedSessionResolver(async () => rows);
    await assert.rejects(resolver(scope), /session not found/);
  }
  const resolver = await loadTrustedSessionResolver(async () => {
    throw new Error("query unavailable");
  });
  await assert.rejects(resolver(scope), /query unavailable/);
});
