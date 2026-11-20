import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT);
const sandbox = await createProjectTestSandbox("session-lifecycle-projection");
const output = await build({
  stdin: {
    contents:
      'export {ConversationProjectionStore} from "./packages/ui/src/v4/conversationProjectionStore.ts"; export {ReplaceableConversationTransport} from "./packages/ui/src/v4/replaceableConversationTransport.ts"; export {createAgentConversationTransport} from "./packages/ui/src/v4/agentConversationTransport.ts";',
    resolveDir: projectRoot,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  packages: "external",
  alias: {
    "@": join(projectRoot, "packages/ui/src"),
    "@zcode/rpc": join(projectRoot, "packages/rpc/src/index.ts"),
  },
});
const bundle = await assertProjectPath(join(sandbox.root, "runtime.mjs"));
await writeFile(bundle, output.outputFiles[0].contents, { flag: "wx" });
const {
  ConversationProjectionStore,
  ReplaceableConversationTransport,
  createAgentConversationTransport,
} = await import(pathToFileURL(bundle).href);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const lifecycle = (state, generation, revision, sessionId = "fixture") => ({
  sessionId,
  state,
  generation,
  revision,
  lastError: null,
});
function transportFixture(firstAck) {
  let listener;
  let removed = 0;
  let calls = 0;
  const unsubscribed = [];
  const ack = (subscriptionId) => ({
    ack: { subscriptionId, mode: "snapshot", logEpoch: "fixture" },
  });
  const transport = {
    getSessionLifecycle: async () => null,
    onSessionLifecycle: (callback) => {
      listener = callback;
      return () => {
        removed += 1;
      };
    },
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
    onFrame: () => () => {},
    subscribe: async () => {
      calls += 1;
      return calls === 1 && firstAck ? await firstAck : ack(`fixture-${calls}`);
    },
    activate: () => {},
    unsubscribe: async (id) => {
      unsubscribed.push(id);
    },
  };
  return {
    transport,
    emit: (value) => listener(value),
    calls: () => calls,
    removed: () => removed,
    unsubscribed,
    ack,
  };
}

test("own starting/ready and stale lifecycle notifications never duplicate cold subscribe", async () => {
  const pending = deferred();
  const f = transportFixture(pending.promise);
  const store = new ConversationProjectionStore("conversation/fixture", f.transport);
  try {
    const connecting = store.connect();
    f.emit(lifecycle("starting", 1, 1));
    f.emit(lifecycle("ready", 1, 2));
    pending.resolve(f.ack("cold"));
    await connecting;
    f.emit(lifecycle("faulted", 1, 1));
    f.emit(lifecycle("stopping", 0, 100));
    f.emit(lifecycle("faulted", 2, 1, "other-session"));
    assert.equal(f.calls(), 1);
    assert.equal(store.getState().status, "live");
    assert.equal(store.getState().runtimeLifecycle.state, "ready");
  } finally {
    await store.close();
  }
  assert.equal(f.removed(), 1);
});

test("stopping invalidates delayed ACK and ready reconnects after its original flight finishes", async () => {
  const pending = deferred();
  const f = transportFixture(pending.promise);
  const store = new ConversationProjectionStore("conversation/fixture", f.transport);
  try {
    const connecting = store.connect();
    f.emit(lifecycle("stopping", 1, 2));
    f.emit(lifecycle("ready", 2, 1));
    assert.equal(f.calls(), 1);
    pending.resolve(f.ack("stale"));
    await connecting;
    await flush();
    assert.deepEqual(f.unsubscribed, ["stale"]);
    assert.equal(f.calls(), 2);
    assert.equal(store.getState().subscriptionId, "fixture-2");
    assert.equal(store.getState().runtimeLifecycle.generation, 2);
  } finally {
    await store.close();
  }
});

test("agent lifecycle port forwards full remote identity and releases the same event subscription", async () => {
  const target = {
    workspacePath: "/fixture",
    workspaceIdentity: "remote:fixture",
    remoteSessionId: "remote-fixture",
  };
  const calls = [];
  let callback,
    disposed = 0;
  const agent = {
    getSessionLifecycle: async (request) => {
      calls.push(request);
      return lifecycle("ready", 1, 1);
    },
    onDynamicSessionLifecycle: (request) => {
      calls.push(request);
      return (listener) => {
        callback = listener;
        return {
          dispose() {
            disposed++;
          },
        };
      };
    },
  };
  const transport = createAgentConversationTransport(agent, target);
  assert.deepEqual(await transport.getSessionLifecycle("fixture"), lifecycle("ready", 1, 1));
  const events = [];
  const release = transport.onSessionLifecycle((snapshot) => events.push(snapshot));
  callback(lifecycle("stopping", 1, 2));
  assert.deepEqual(calls, [{ ...target, sessionId: "fixture" }, target]);
  assert.deepEqual(events, [lifecycle("stopping", 1, 2)]);
  release();
  assert.equal(disposed, 1);
});

test("a later ready generation invalidates the old subscription even when stopping was missed", async () => {
  const f = transportFixture();
  const store = new ConversationProjectionStore("conversation/fixture", f.transport);
  try {
    await store.connect();
    f.emit(lifecycle("ready", 1, 1));
    f.emit(lifecycle("ready", 2, 1));
    await flush();
    assert.equal(f.calls(), 2);
    assert.equal(store.getState().subscriptionId, "fixture-2");
    assert.deepEqual(f.unsubscribed, ["fixture-1"]);
  } finally {
    await store.close();
  }
});

test("remote proxy replacement drops captured old lifecycle reads and callbacks", async () => {
  const pending = deferred();
  const old = transportFixture();
  old.transport.getSessionLifecycle = () => pending.promise;
  const current = transportFixture();
  const proxy = new ReplaceableConversationTransport(old.transport);
  const events = [];
  const release = proxy.onSessionLifecycle((snapshot) => events.push(snapshot));
  const reading = proxy.getSessionLifecycle("fixture");
  proxy.replace(current.transport);
  old.emit(lifecycle("faulted", 10, 1));
  pending.resolve(lifecycle("ready", 10, 2));
  assert.equal(await reading, null);
  current.emit(lifecycle("ready", 1, 1));
  assert.equal(events.length, 1);
  assert.equal(old.removed(), 1);
  release();
  assert.equal(current.removed(), 1);
});
