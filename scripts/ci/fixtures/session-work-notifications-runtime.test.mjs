import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertProjectPath, projectRoot } from "../project-test-sandbox.mjs";

// 父入口已经审查并绑定 HOME/APPDATA/TEMP/业务数据目录和 Node 写入白名单。
const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT ?? "");
const [{ JSDOM }, { build, stop }] = await Promise.all([import("jsdom"), import("esbuild")]);
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://session-notification-fixture.invalid/",
});
const globalKeys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"];
const previousGlobals = new Map(
  globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const key of globalKeys) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[key],
  });
}
const fixturePath = await assertProjectPath(join(sandbox, "notification-hook.mjs"));
const mocks = {
  "@/hooks/useServices.js":
    "export const useServices = () => globalThis.notificationFixture.services;",
  "@/logger.js": "export const logger = { warn() {} };",
  "@/v4/sessionsIndexRegistry.js": `
    export function acquireSessionsIndex(scope) {
      globalThis.notificationFixture.acquired.push(scope);
      return globalThis.notificationFixture.store;
    }
    export function releaseSessionsIndex(scope, store) {
      globalThis.notificationFixture.released.push({ scope, store });
    }
  `,
};
const { outputFiles } = await build({
  stdin: {
    contents:
      'export { useWorkspaceTerminalTaskNotifications } from "./packages/ui/src/hooks/useTaskNotifications.ts";',
    resolveDir: projectRoot,
    loader: "ts",
  },
  outfile: fixturePath,
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  alias: { "@": join(projectRoot, "packages/ui/src") },
  external: ["react", "react/*"],
  plugins: [
    {
      name: "memory-notification-ports",
      setup(builder) {
        builder.onResolve({ filter: /^@\// }, ({ path }) =>
          path in mocks ? { path, namespace: "notification-port" } : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: "notification-port" }, ({ path }) => ({
          contents: mocks[path],
          loader: "js",
        }));
      },
    },
  ],
});
stop();
await writeFile(fixturePath, outputFiles[0].contents, { flag: "wx" });
const { useWorkspaceTerminalTaskNotifications } = await import(pathToFileURL(fixturePath).href);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
let mountedRoot;

function session(phase = "running", overrides = {}) {
  return {
    sessionId: "session-fixture-a",
    workspaceId: "workspace-fixture",
    title: "Synthetic session",
    phase,
    sessionEnded: phase === "completedSuccess" || phase === "completedInterrupted",
    hasBackgroundWork: false,
    lastActivityAt: 10,
    createdAt: 1,
    ...overrides,
  };
}

async function fixture(initial = [session()], epoch = "epoch-a", overrides = {}) {
  let sessions = initial;
  let logEpoch = epoch;
  let status = "live";
  const listeners = new Set();
  const payloads = [];
  const f = {
    acquired: [],
    released: [],
    services: { zcodeAgentService: {} },
    store: {
      getState: () => ({ logEpoch }),
      getStatus: () => status,
      getSessions: () => sessions,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    payloads,
    publish(next, options = {}) {
      sessions = next;
      if ("epoch" in options) logEpoch = options.epoch;
      status = options.status ?? "live";
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
  const props = {
    workspacePath: join(sandbox, "synthetic-workspace"),
    enabled: true,
    rpcReady: true,
    platform: { showTaskNotification: (payload) => payloads.push(payload) },
    formatMessage: ({ id }, values) => values?.title ?? id,
    ...overrides,
  };
  function Observer() {
    useWorkspaceTerminalTaskNotifications(props);
    return null;
  }
  globalThis.notificationFixture = f;
  mountedRoot = createRoot(document.getElementById("root"));
  await act(async () => mountedRoot.render(createElement(Observer)));
  return f;
}

async function unmount() {
  if (!mountedRoot) return;
  await act(async () => mountedRoot.unmount());
  mountedRoot = null;
}
afterEach(unmount);
after(() => {
  dom.window.close();
  delete globalThis.notificationFixture;
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

test("WSC05：用户停止或立即发送中断不会提示任务已完成", async () => {
  const f = await fixture();
  await act(async () => f.publish([session("completedInterrupted")]));
  assert.deepEqual(f.payloads, []);
});

test("WSC05：普通成功/失败各提示一次，保留后台工作完成契约", async () => {
  const f = await fixture();
  for (const next of [
    session("completedSuccess", { hasBackgroundWork: true }),
    session("completedSuccess", { hasBackgroundWork: true, title: "Renamed" }),
    session(),
    session("error"),
    session("error", { lastActivityAt: 20 }),
  ])
    await act(async () => f.publish([next]));
  assert.deepEqual(
    f.payloads.map((payload) => payload.status),
    ["completed", "failed"],
  );
});

test("WSC06：Goal 中间轮不提示完成，最终验证通过恰好一次", async () => {
  const f = await fixture([session("running", { goalStatus: "active" })]);
  for (const goalStatus of ["active", "verifying", "notSatisfied", "paused", "failed"]) {
    await act(async () => f.publish([session("completedSuccess", { goalStatus })]));
    assert.deepEqual(f.payloads, []);
  }
  for (const next of [
    session("running", { goalStatus: "active" }),
    session("completedSuccess", { goalStatus: "verified" }),
    session("completedSuccess", { goalStatus: "verified", lastActivityAt: 25 }),
  ])
    await act(async () => f.publish([next]));
  assert.equal(f.payloads.length, 1);
  assert.equal(f.payloads[0].status, "completed");
});

test("WSC06：phase 不变的 Goal verified 边沿仍提示最终完成", async () => {
  const f = await fixture([session("completedSuccess", { goalStatus: "notSatisfied" })]);
  await act(async () => f.publish([session("completedSuccess", { goalStatus: "verified" })]));
  assert.equal(f.payloads.length, 1);
});

test("WSC08：自动队列待续跑时不通知，phase 不变的最终收口恰好一次", async () => {
  const f = await fixture();
  await act(async () => f.publish([session("completedSuccess", { autoContinuePending: true })]));
  assert.deepEqual(f.payloads, []);
  await act(async () => f.publish([session("completedSuccess", { autoContinuePending: false })]));
  await act(async () =>
    f.publish([session("completedSuccess", { autoContinuePending: false, title: "Renamed" })]),
  );
  assert.equal(f.payloads.length, 1);
});

test("WSC07：新 epoch 冷终态只建立基线，同 epoch 新工作恢复完成仍通知", async () => {
  const f = await fixture();
  await act(async () => f.publish([session("completedSuccess")], { epoch: "epoch-b" }));
  assert.deepEqual(f.payloads, []);
  await act(async () => f.publish([session()], { epoch: "epoch-b" }));
  await act(async () => f.publish([session()], { status: "connecting" }));
  await act(async () => f.publish([session("completedSuccess")], { epoch: "epoch-b" }));
  assert.equal(f.payloads.length, 1);
});

test("WSC07：失去有效投影后同 epoch 冷恢复也不重放旧完成", async () => {
  const f = await fixture();
  await act(async () => {
    f.publish([], { epoch: null, status: "dormant" });
    f.publish([session("completedSuccess")], { epoch: "epoch-a" });
    assert.deepEqual(f.payloads, []);
    f.publish([session()]);
    f.publish([], { epoch: null, status: "error" });
    f.publish([session("completedSuccess")], { epoch: "epoch-a" });
  });
  assert.deepEqual(f.payloads, []);
});

test("WSC07：终态同步消费，不等待 React 提交后读取陈旧摘要", async () => {
  const f = await fixture();
  await act(async () => {
    f.publish([session("completedSuccess")]);
    assert.equal(f.payloads.length, 1);
    f.publish([session()]);
  });
  assert.equal(f.payloads.length, 1);
});

test("WSC07：远程身份和 endpoint 保留，卸载解除订阅，未就绪不观察", async () => {
  const f = await fixture(undefined, undefined, {
    workspaceIdentity: " synthetic-remote-identity ",
    endpointKey: " synthetic-attachment ",
  });
  assert.equal(f.acquired[0].workspaceKey, "synthetic-remote-identity");
  assert.equal(f.acquired[0].endpointKey, "synthetic-attachment");
  await unmount();
  f.publish([session("completedSuccess")]);
  assert.equal(f.listenerCount(), 0);
  assert.equal(f.released.length, 1);
  assert.deepEqual(f.payloads, []);
  const disconnected = await fixture(undefined, undefined, { rpcReady: false });
  assert.equal(disconnected.acquired.length, 0);
});
