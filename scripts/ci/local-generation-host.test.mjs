import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { Emitter } from "../../packages/rpc/src/foundation.ts";
import {
  ESTIMATED_TOKEN_CHAR_DIVISOR,
  calculateOutputTps,
  isRemoteWorkspaceIdentity,
} from "@zcode/shared";
import {
  GENERATION_STREAMING_PUSH_INTERVAL_MS,
  workspaceScopeKey,
} from "@zcode/shared/extension-host";
import { assertProjectPath, projectRoot } from "./project-test-sandbox.mjs";

await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT);
async function loadFunction(file, name, ports) {
  const source = await readFile(join(projectRoot, file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find((item) => item.name?.text === name);
  assert.ok(node, name);
  const { outputText } = ts.transpileModule(node.getText(ast).replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return new Function(...Object.keys(ports), `${outputText}\nreturn ${name};`)(
    ...Object.values(ports),
  );
}
const createWorkspaceSubscriptions = await loadFunction(
  "packages/services/src/extensions/workbenchState.ts",
  "createWorkspaceSubscriptions",
  { workspaceScopeKey },
);
const createGenerationPump = await loadFunction(
  "packages/services/src/extensions/generationPump.ts",
  "createGenerationPump",
  {
    Emitter,
    ESTIMATED_TOKEN_CHAR_DIVISOR,
    calculateOutputTps,
    isRemoteWorkspaceIdentity,
    GENERATION_STREAMING_PUSH_INTERVAL_MS,
    workspaceScopeKey,
    createWorkspaceSubscriptions,
  },
);
function harness(workspaces = [{ workspacePath: "fixture-a" }]) {
  const channels = new Map();
  const reports = new Emitter();
  let subscriptions = 0;
  let now = 1000;
  const pump = createGenerationPump({
    workbench: { workspaces: () => workspaces, onDidChangeReport: reports.event },
    agent: {
      onDynamicLocalGenerationFacts(workspace) {
        subscriptions += 1;
        const channel = new Emitter();
        channels.set(workspaceScopeKey(workspace), channel);
        return channel.event;
      },
    },
    now: () => now,
    logger: { info() {}, debug() {} },
  });
  const output = [];
  let listener;
  let eventId = 0;
  return {
    output,
    pump,
    listen() {
      listener = pump.onDidGenerate((fact) => output.push(fact));
    },
    unlisten() {
      listener?.dispose();
    },
    get subscriptions() {
      return subscriptions;
    },
    emit(kind, overrides = {}, workspace = workspaces[0]) {
      now += 500;
      channels.get(workspaceScopeKey(workspace))?.fire({
        kind,
        version: 1,
        instanceId: "instance-1",
        sessionId: "session-1",
        requestId: "request-1",
        providerId: "provider-1",
        modelId: "model-1",
        occurredAt: now,
        eventId: `event-${++eventId}`,
        ...overrides,
      });
    },
  };
}
test("没有扩展监听不订阅，末个监听退出后释放派生缓存", () => {
  const h = harness();
  assert.equal(h.subscriptions, 0);
  h.listen();
  assert.equal(h.subscriptions, 1);
  h.emit("started");
  h.emit("chunk", { chars: 300 });
  h.unlisten();
  h.listen();
  h.emit("chunk", { chars: 300 });
  assert.equal(h.output.length, 0);
  assert.equal(h.subscriptions, 2);
  h.pump.dispose();
});
test("重复事件不累计，重试清零，终态使用服务商tokens", () => {
  const h = harness();
  h.listen();
  h.emit("started");
  h.emit("chunk", { chars: 300, eventId: "first", occurredAt: 1000 });
  h.emit("chunk", { chars: 300, eventId: "first", occurredAt: 1000 });
  h.emit("chunk", { chars: 300, occurredAt: 2000 });
  assert.equal(h.output[0].outputTokensPerSecond, 200);
  h.emit("retry");
  h.emit("chunk", { chars: 30, occurredAt: 3000 });
  h.emit("chunk", { chars: 30, occurredAt: 4000 });
  assert.equal(h.output[1].outputTokensPerSecond, 20);
  h.emit("completed", { outputTokens: 40, durationMs: 3000, timeToFirstContentMs: 1000 });
  assert.equal(h.output[2].phase, "final");
  assert.equal(h.output[2].outputTokensPerSecond, 20);
  h.emit("chunk", { chars: 300 });
  assert.equal(h.output.length, 3);
  h.pump.dispose();
});
test("同名会话按工作区隔离，实例换代释放旧请求", () => {
  const a = { workspacePath: "fixture-a" },
    b = { workspacePath: "fixture-b" };
  const h = harness([a, b]);
  h.listen();
  h.emit("started", {}, a);
  h.emit("started", { requestId: "request-b" }, b);
  h.emit("chunk", { chars: 300, occurredAt: 1000 }, a);
  h.emit("chunk", { chars: 30, occurredAt: 1000 }, b);
  h.emit("chunk", { chars: 300, occurredAt: 2000 }, a);
  h.emit("chunk", { chars: 30, occurredAt: 2000 }, b);
  assert.deepEqual(
    h.output.map((item) => item.outputTokensPerSecond),
    [200, 20],
  );
  h.emit("chunk", { instanceId: "instance-2", chars: 999 }, a);
  assert.equal(h.output.length, 2);
  h.emit("failed", { requestId: "request-b" }, b);
  h.emit("chunk", { chars: 999 }, b);
  assert.equal(h.output.length, 2);
  h.pump.dispose();
});
test("未知首输出时长不补造准确值", () => {
  const h = harness();
  h.listen();
  h.emit("completed", { outputTokens: 40, durationMs: 3000 });
  h.emit("completed", { outputTokens: 40, durationMs: 1000, timeToFirstContentMs: 1000 });
  assert.equal(h.output.length, 0);
  h.pump.dispose();
});
