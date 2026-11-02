import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  ServiceCollection,
  IWindowControllerService,
  IWindowProjectService,
  IWindowRemoteProjectService,
  IWindowProjectChangesService,
  IProjectService,
  IRemoteProjectService,
  IBroadcastService,
} from "../../packages/services/src/index.ts";
import { createWindowProjectChangesService } from "../../packages/services/src/window-project-directory/index.ts";
import {
  createRemotePromptAttachmentTaskService,
  createRemotePromptAttachmentSessionService,
} from "../../packages/desktop/src/host/remotePromptAttachments.ts";

test("remote attachment aliases the local window project owner and forwards its changes", async () => {
  const text = await readFile(
    new URL("../../packages/desktop/src/host/index.ts", import.meta.url),
    "utf8",
  );
  const file = ts.createSourceFile("host.ts", text, ts.ScriptTarget.Latest, true);
  let block;
  function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(file) === "controllerAttachment")
      block = node.thenStatement;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(block);
  const source = ts.transpileModule(block.getText(file), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  let listener,
    subscriptions = 0,
    disposals = 0;
  const broadcast = {
    onMessage(callback) {
      listener = callback;
      subscriptions++;
      return {
        dispose() {
          disposals++;
        },
      };
    },
  };
  const project = { readProjects: async () => ["local-project"] };
  const remoteProjects = {
    readDirectory: async () => ({ hosts: ["local-membership"], entries: [] }),
  };
  const owner = new ServiceCollection()
    .register(IProjectService, project)
    .register(IRemoteProjectService, remoteProjects)
    .register(IBroadcastService, broadcast);
  const sourceServices = new ServiceCollection().register(IProjectService, {
    readProjects: async () => ["wrong-source-project"],
  });
  const deps = {
    services: sourceServices,
    activeServices: owner,
    windowHostControllerRuntime: { service: {} },
    controllerAttachment: {},
    overrides: new Map(),
    IWindowControllerService,
    IWindowProjectService,
    IWindowRemoteProjectService,
    IWindowProjectChangesService,
    IProjectService,
    IRemoteProjectService,
    IBroadcastService,
    createWindowProjectChangesService,
  };
  const execute = new Function(...Object.keys(deps), source);
  execute(...Object.values(deps));
  assert.equal(sourceServices.get(IWindowProjectService), project);
  assert.equal(sourceServices.get(IWindowRemoteProjectService), remoteProjects);
  let changes = 0;
  const subscription = sourceServices
    .get(IWindowProjectChangesService)
    .onDidChange(() => changes++);
  listener({ channel: "state:tasks" });
  assert.equal(changes, 0);
  listener({ channel: "state:projects" });
  assert.equal(changes, 1);
  subscription.dispose();
  assert.equal(subscriptions, 1);
  assert.equal(disposals, 1);
  deps.activeServices = undefined;
  assert.throws(() => execute(...Object.values(deps)), /Window project owner unavailable/);
});

for (const [name, wrap, input] of [
  ["task", createRemotePromptAttachmentTaskService, { taskId: "task-a", traceId: "trace-a" }],
  [
    "session",
    createRemotePromptAttachmentSessionService,
    { sessionId: "task-a", inputId: "input-a" },
  ],
])
  test(`${name} attachment staging completes before the original service receives one command`, async () => {
    const order = [],
      sends = [];
    const original = Object.freeze({
      ...input,
      content: "fixture-input",
      attachments: [{ type: "file", filename: "fixture.txt" }],
      commandId: "command-a",
    });
    const base = {
      async sendPrompt(value) {
        assert.equal(this, base);
        order.push("send");
        sends.push(value);
        return "accepted";
      },
    };
    const proxy = wrap(base, {
      async materializePromptAttachments(value) {
        order.push("stage");
        assert.equal(value.taskId, "task-a");
        return { content: "staged-input", attachments: [] };
      },
    });
    assert.equal(await proxy.sendPrompt(original), "accepted");
    assert.deepEqual(order, ["stage", "send"]);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].commandId, original.commandId);
    assert.equal(original.content, "fixture-input");
    assert.equal(sends[0].content, "staged-input");
    const failed = wrap(base, {
      async materializePromptAttachments() {
        throw new Error("staging rejected");
      },
    });
    await assert.rejects(failed.sendPrompt(original), /staging rejected/);
    assert.equal(sends.length, 1);
  });
