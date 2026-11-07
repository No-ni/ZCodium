import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, afterEach, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertProjectPath, projectRoot } from "../project-test-sandbox.mjs";

// 只操作内存 native/IPC 端口；不创建 Electron 窗口或真实系统通知，写入归项目 sandbox。
const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT ?? "");
const [{ JSDOM }, { build, transform, stop }, { default: ts }] = await Promise.all([
  import("jsdom"),
  import("esbuild"),
  import("typescript"),
]);
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://notification-platform.invalid/",
});
const previous = new Map();
for (const key of ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[key],
  });
}
const realNow = Date.now;
const facts = [];
const mocks = {
  "@/hooks/useServices.js":
    "export const useServices = () => globalThis.notificationPlatformAudit.services;",
  "@/logger.js": "export const logger = { warn() {} };",
  "@/v4/sessionsIndexRegistry.js": `
    export const acquireSessionsIndex = () => globalThis.notificationPlatformAudit.store;
    export function releaseSessionsIndex() {}
  `,
  "@zcode/ui": `
    export const isBrowserClipboardAvailable = () => false;
    export function selectBrowserFileData() {}
    export function writeBrowserClipboardText() {}
  `,
  "./desktopBrowserPlatformBridge.js": "export const desktopBrowserPlatformBridge = {};",
  "./plugin-sandbox/desktopPluginSandboxPlatform.js":
    "export const createDesktopPluginSandboxPlatform = () => ({});",
  electron: `
    export const app = {};
    export const BrowserWindow = {
      getAllWindows: () => [globalThis.notificationPlatformAudit.sender],
      fromWebContents: () => globalThis.notificationPlatformAudit.sender,
    };
    export const Notification = globalThis.notificationAuditNative;
  `,
};
globalThis.notificationAuditNative = class extends EventEmitter {
  static isSupported() {
    return true;
  }
  constructor(options) {
    super();
    this.options = options;
  }
  show() {
    const audit = globalThis.notificationPlatformAudit;
    audit.shown.push({ payload: audit.delivering, current: audit.current, options: this.options });
  }
};
const bundlePath = await assertProjectPath(join(sandbox, "notification-platform.mjs"));
const preloadFile = ts.createSourceFile(
  "preload.ts",
  await readFile(join(projectRoot, "packages/desktop/src/preload/index.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let forwarding;
function findForwarding(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(preloadFile) === "showTaskNotification")
    forwarding = node.initializer.getText(preloadFile);
  ts.forEachChild(node, findForwarding);
}
findForwarding(preloadFile);
assert.ok(forwarding, "必须回放真实 preload 的 showTaskNotification 表达式");
let forwardingSource;
try {
  forwardingSource = (await transform(`(${forwarding})`, { loader: "ts" })).code;
  const result = await build({
    stdin: {
      contents: `
        export { useWorkspaceTerminalTaskNotifications } from "./packages/ui/src/hooks/useTaskNotifications.ts";
        export { createDesktopPlatform } from "./packages/desktop/src/renderer/src/desktopPlatform.ts";
        export { dispatchTaskNotification, resetActiveTaskNotificationsForTest } from "./packages/desktop/src/main/desktopNotifications.ts";
        export { PlatformChannels } from "@zcode/shared";
      `,
      resolveDir: projectRoot,
      loader: "ts",
    },
    bundle: true,
    write: false,
    outfile: bundlePath,
    platform: "node",
    format: "esm",
    alias: {
      "@": join(projectRoot, "packages/ui/src"),
      "@zcode/shared": join(projectRoot, "packages/shared/src/index.ts"),
      "@zcode/shared/zcode-protocol-v4": join(
        projectRoot,
        "packages/shared/src/zcode-protocol-v4/index.ts",
      ),
    },
    external: ["react", "react/*"],
    logLevel: "silent",
    plugins: [
      {
        name: "notification-platform-memory-ports",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path }) =>
            path in mocks ? { path, namespace: "audit-port" } : undefined,
          );
          builder.onLoad({ filter: /.*/, namespace: "audit-port" }, ({ path }) => ({
            contents: mocks[path],
            loader: "js",
          }));
        },
      },
    ],
  });
  await writeFile(bundlePath, result.outputFiles[0].contents, { flag: "wx" });
} finally {
  stop();
}
const {
  useWorkspaceTerminalTaskNotifications,
  createDesktopPlatform,
  dispatchTaskNotification,
  resetActiveTaskNotificationsForTest,
  PlatformChannels,
} = await import(pathToFileURL(bundlePath).href);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
let root;
let activeAudit;
const summary = (phase, activity, extra = {}) => ({
  sessionId: "platform-session",
  workspaceId: "platform-workspace",
  title: "Synthetic task",
  phase,
  sessionEnded: phase === "completedSuccess",
  hasBackgroundWork: false,
  lastActivityAt: activity,
  createdAt: 1,
  ...extra,
});
async function fixture() {
  const listeners = new Set();
  let sessions = [summary("running", 100)];
  let logEpoch = "platform-epoch";
  let eventSerial = 0;
  const audit = {
    services: { zcodeAgentService: {} },
    queued: [],
    shown: [],
    sounds: [],
    clock: 10_000,
    current: { phase: "running", logEpoch },
    sender: { isDestroyed: () => false, isFocused: () => false, webContents: { send() {} } },
    store: {
      getState: () => ({ logEpoch }),
      getStatus: () => "live",
      getSessions: () => sessions,
      subscribe(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
    publish(phase, epoch = logEpoch, extra = {}) {
      logEpoch = epoch;
      audit.clock += 10;
      const notificationEventId =
        phase === "completedSuccess" || phase === "error"
          ? `synthetic-event-${++eventSerial}`
          : undefined;
      sessions = [summary(phase, audit.clock, { notificationEventId, ...extra })];
      audit.current = { phase, logEpoch };
      for (const callback of listeners) callback();
    },
    deliver(payload = audit.queued.shift()) {
      audit.delivering = payload;
      return dispatchTaskNotification({
        payload,
        event: { sender: { send: (...args) => audit.sounds.push(args) } },
        logger: { info() {}, warn() {} },
      });
    },
  };
  activeAudit = audit;
  globalThis.notificationPlatformAudit = audit;
  Date.now = () => audit.clock;
  resetActiveTaskNotificationsForTest();
  // 使用真实 preload arrow；唯一替身是 IPC 发送端口，在这里延迟实际 Main 消费。
  const send = (channel, payload) => {
    assert.equal(channel, PlatformChannels.ShowTaskNotification);
    audit.queued.push(payload);
  };
  window.zcode = {
    showTaskNotification: new Function(
      "ipcRenderer",
      "PlatformChannels",
      `return ${forwardingSource}`,
    )({ send }, PlatformChannels),
  };
  const props = {
    workspacePath: join(sandbox, "workspace-a"),
    enabled: true,
    rpcReady: true,
    platform: createDesktopPlatform({ isLocalDevelopmentRuntime: true }),
    formatMessage: ({ id }, values) => values?.title ?? id,
  };
  function Observer({ params }) {
    useWorkspaceTerminalTaskNotifications(params);
    return null;
  }
  root = createRoot(document.getElementById("root"));
  await act(async () => root.render(createElement(Observer, { params: props })));
  audit.renderScope = async (overrides = {}) => {
    await act(async () =>
      root.render(createElement(Observer, { params: { ...props, ...overrides } })),
    );
  };
  audit.addWindowObserver = async () => {
    await act(async () =>
      root.render(
        createElement(
          "div",
          {},
          createElement(Observer, { key: "first-window", params: props }),
          createElement(Observer, { key: "second-window", params: props }),
        ),
      ),
    );
  };
  audit.switchWorkspace = async () => {
    await act(async () =>
      root.render(
        createElement(Observer, {
          params: { ...props, workspacePath: join(sandbox, "workspace-b") },
        }),
      ),
    );
  };
  return audit;
}
afterEach(async (t) => {
  facts.push({ case: t.name, queued: activeAudit.queued.length, shown: activeAudit.shown });
  if (root) await act(async () => root.unmount());
  root = undefined;
  resetActiveTaskNotificationsForTest();
  Date.now = realNow;
});
after(async () => {
  await writeFile(join(sandbox, "facts.json"), JSON.stringify(facts, null, 2), { flag: "wx" });
  dom.window.close();
  delete globalThis.notificationPlatformAudit;
  delete globalThis.notificationAuditNative;
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

test("有效完成已发送，Main 迟到消费时新轮 running：记录平台滞后边界", async () => {
  const audit = await fixture();
  await act(async () => audit.publish("completedSuccess"));
  await act(async () => audit.publish("running"));
  assert.equal(audit.queued.length, 1);
  assert.equal(audit.deliver(), true);
  assert.equal(audit.shown[0].payload.status, "completed");
  assert.equal(audit.shown[0].current.phase, "running");
});
test("有效完成已发送后 epoch 变化：冷基线不重发，已发送 IPC 仍会被消费", async () => {
  const audit = await fixture();
  await act(async () => audit.publish("completedSuccess"));
  await act(async () => audit.publish("running", "new-platform-epoch"));
  assert.equal(audit.queued.length, 1);
  assert.equal(audit.deliver(), true);
  assert.equal(audit.shown[0].current.logEpoch, "new-platform-epoch");
});
test("有效完成已发送后换工作区并卸载：已发送 IPC 不随 hook 清理撤回", async () => {
  const audit = await fixture();
  await act(async () => audit.publish("completedSuccess"));
  await audit.switchWorkspace();
  await act(async () => root.unmount());
  root = undefined;
  assert.equal(audit.queued.length, 1);
  assert.equal(audit.deliver(), true);
});
test("同会话两个不同有效完成边沿不能被 Main 的 3 秒窗口合并", async () => {
  const audit = await fixture();
  await act(async () => audit.publish("completedSuccess"));
  audit.deliver();
  await act(async () => audit.publish("running"));
  await act(async () => audit.publish("completedSuccess"));
  audit.deliver();
  assert.equal(audit.shown.length, 2);
});
test("同会话两个不同失败边沿不能被 Main 的 3 秒窗口合并", async () => {
  const audit = await fixture();
  await act(async () => audit.publish("error"));
  audit.deliver();
  await act(async () => audit.publish("running"));
  await act(async () => audit.publish("error"));
  audit.deliver();
  assert.equal(audit.shown.length, 2);
});
test("合法合批/恢复摘要省略中间 running，两个稳定完成身份仍各展示一次", async () => {
  const audit = await fixture();
  await act(async () =>
    audit.publish("completedSuccess", undefined, { notificationEventId: "recovery-event-a" }),
  );
  audit.deliver();
  await act(async () =>
    audit.publish("completedSuccess", undefined, { notificationEventId: "recovery-event-b" }),
  );
  audit.deliver();
  assert.equal(audit.shown.length, 2);
});
test("Goal 同 phase 两次最终验证边沿保持不同通知身份", async () => {
  const audit = await fixture();
  await act(async () =>
    audit.publish("completedSuccess", undefined, {
      goalStatus: "active",
      notificationEventId: undefined,
    }),
  );
  assert.equal(audit.queued.length, 0);
  await act(async () =>
    audit.publish("completedSuccess", undefined, {
      goalStatus: "verified",
      notificationEventId: "goal-verified-a",
    }),
  );
  audit.deliver();
  await act(async () =>
    audit.publish("completedSuccess", undefined, {
      goalStatus: "active",
      notificationEventId: undefined,
    }),
  );
  await act(async () =>
    audit.publish("completedSuccess", undefined, {
      goalStatus: "verified",
      notificationEventId: "goal-verified-b",
    }),
  );
  audit.deliver();
  assert.equal(audit.shown.length, 2);
  assert.notEqual(audit.shown[0].payload.notificationId, audit.shown[1].payload.notificationId);
});
test("自动队列同 phase 两次收口边沿保持不同通知身份", async () => {
  const audit = await fixture();
  await act(async () =>
    audit.publish("completedSuccess", undefined, {
      autoContinuePending: true,
      notificationEventId: undefined,
    }),
  );
  assert.equal(audit.queued.length, 0);
  await act(async () =>
    audit.publish("completedSuccess", undefined, {
      autoContinuePending: false,
      notificationEventId: "queue-settled-a",
    }),
  );
  audit.deliver();
  await act(async () =>
    audit.publish("completedSuccess", undefined, {
      autoContinuePending: true,
      notificationEventId: undefined,
    }),
  );
  await act(async () =>
    audit.publish("completedSuccess", undefined, {
      autoContinuePending: false,
      notificationEventId: "queue-settled-b",
    }),
  );
  audit.deliver();
  assert.equal(audit.shown.length, 2);
});
test("同一完成 payload 的重复 IPC 投递仍只显示一次", async () => {
  const audit = await fixture();
  await act(async () => audit.publish("completedSuccess"));
  const payload = audit.queued.shift();
  assert.equal(audit.deliver(payload), true);
  assert.equal(audit.deliver(payload), false);
  assert.equal(audit.shown.length, 1);
});
test("两个窗口观察同一事件，迟到超过三秒的第二 payload 仍被去重", async () => {
  const audit = await fixture();
  await audit.addWindowObserver();
  await act(async () => audit.publish("completedSuccess"));
  assert.equal(audit.queued.length, 2);
  assert.equal(audit.queued[0].notificationId, audit.queued[1].notificationId);
  assert.equal(audit.deliver(), true);
  audit.clock += 10_000;
  assert.equal(audit.deliver(), false);
  assert.equal(audit.shown.length, 1);
});
for (const [scope, overrides] of [
  ["workspace identity", { workspaceIdentity: "synthetic-remote-workspace" }],
  ["workspace path fallback", { workspacePath: join(sandbox, "workspace-other") }],
  ["endpoint", { endpointKey: "synthetic-other-host" }],
]) {
  test(`同 task/event 在不同 ${scope} 各显示一次`, async () => {
    const audit = await fixture();
    await act(async () =>
      audit.publish("completedSuccess", undefined, { notificationEventId: "same-event" }),
    );
    audit.deliver();
    await audit.renderScope(overrides);
    await act(async () => audit.publish("running"));
    await act(async () =>
      audit.publish("completedSuccess", undefined, { notificationEventId: "same-event" }),
    );
    audit.deliver();
    assert.equal(audit.shown.length, 2);
    assert.notEqual(audit.shown[0].payload.notificationId, audit.shown[1].payload.notificationId);
  });
}
test("同 task/event 在不同 index epoch 各显示一次且换代 snapshot 只是基线", async () => {
  const audit = await fixture();
  await act(async () =>
    audit.publish("completedSuccess", undefined, { notificationEventId: "same-event" }),
  );
  audit.deliver();
  await act(async () =>
    audit.publish("completedSuccess", "new-platform-epoch", { notificationEventId: "same-event" }),
  );
  assert.equal(audit.queued.length, 0);
  await act(async () => audit.publish("running"));
  await act(async () =>
    audit.publish("completedSuccess", undefined, { notificationEventId: "same-event" }),
  );
  audit.deliver();
  assert.equal(audit.shown.length, 2);
});
test("旧 CLI 无事件身份沿真实 hook 保留旧三秒去重与超时兼容", async () => {
  const audit = await fixture();
  const finish = () =>
    audit.publish("completedSuccess", undefined, { notificationEventId: undefined });
  await act(async () => finish());
  const payload = audit.queued.shift();
  assert.equal(payload.notificationId, undefined);
  assert.equal(audit.deliver(payload), true);
  assert.equal(audit.deliver(payload), false);
  audit.clock += 4000;
  assert.equal(audit.deliver(payload), true);
});
test("已标识终态使用有限 FIFO，淘汰最旧键且保留较新键", async () => {
  const audit = await fixture();
  await act(async () => audit.publish("completedSuccess"));
  const payload = audit.queued.shift();
  for (let i = 0; i <= 4096; i++)
    assert.equal(audit.deliver({ ...payload, notificationId: `synthetic-capacity-${i}` }), true);
  assert.equal(audit.deliver({ ...payload, notificationId: "synthetic-capacity-1" }), false);
  assert.equal(audit.deliver({ ...payload, notificationId: "synthetic-capacity-0" }), true);
});
test("同任务不同交互请求在 3 秒内仍各自显示", async () => {
  const audit = await fixture();
  const payload = {
    taskId: "platform-session",
    status: "elicitation_request",
    title: "Synthetic input",
    body: "Synthetic request",
  };
  assert.equal(audit.deliver({ ...payload, requestId: "request-a" }), true);
  assert.equal(audit.deliver({ ...payload, requestId: "request-b" }), true);
  assert.equal(audit.shown.length, 2);
});
test("permission requestId 仍拥有交互去重语义，不消费终态 notificationId", async () => {
  const audit = await fixture();
  const payload = {
    taskId: "platform-session",
    status: "permission_request",
    title: "Synthetic permission",
    body: "Synthetic request",
  };
  assert.equal(
    audit.deliver({ ...payload, requestId: "permission-a", notificationId: "irrelevant-a" }),
    true,
  );
  assert.equal(
    audit.deliver({ ...payload, requestId: "permission-a", notificationId: "irrelevant-b" }),
    false,
  );
  assert.equal(
    audit.deliver({ ...payload, requestId: "permission-b", notificationId: "irrelevant-a" }),
    true,
  );
  assert.equal(audit.shown.length, 2);
});
