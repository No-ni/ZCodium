import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertProjectPath, projectRoot } from "../project-test-sandbox.mjs";

// 仅真实 hook 与内存摘要端口：环境和 bundle 由项目隔离入口约束，不读用户数据。
const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT ?? "");
const [{ JSDOM }, { build, stop }] = await Promise.all([import("jsdom"), import("esbuild")]);
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://notification-subscription.invalid/",
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
const mocks = {
  "@/hooks/useServices.js":
    "export const useServices = () => globalThis.subscriptionAudit.services;",
  "@/logger.js": "export const logger = { warn() {} };",
  "@/v4/sessionsIndexRegistry.js": `
    export function acquireSessionsIndex() { return globalThis.subscriptionAudit.store; }
    export function releaseSessionsIndex() {}
  `,
};
const bundlePath = await assertProjectPath(join(sandbox, "notification-subscription.mjs"));
try {
  const result = await build({
    stdin: {
      contents:
        'export { useWorkspaceTerminalTaskNotifications } from "./packages/ui/src/hooks/useTaskNotifications.ts";',
      resolveDir: projectRoot,
      loader: "ts",
    },
    outfile: bundlePath,
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    alias: { "@": join(projectRoot, "packages/ui/src") },
    external: ["react", "react/*"],
    logLevel: "silent",
    plugins: [
      {
        name: "audit-memory-ports",
        setup(builder) {
          builder.onResolve({ filter: /^@\// }, ({ path }) =>
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
const { useWorkspaceTerminalTaskNotifications } = await import(pathToFileURL(bundlePath).href);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
let root;
const summary = (phase = "running") => ({
  sessionId: "audit-session",
  workspaceId: "audit-workspace",
  title: "Synthetic task",
  phase,
  sessionEnded: phase === "completedSuccess",
  hasBackgroundWork: false,
  lastActivityAt: 10,
  createdAt: 1,
});
const english = ({ id }, values) => values?.title ?? `en:${id}`;
const chinese = ({ id }, values) => values?.title ?? `zh:${id}`;

async function fixture() {
  let sessions = [summary()];
  let status = "live";
  const listeners = new Set();
  const notifications = [];
  const audit = {
    services: { zcodeAgentService: {} },
    store: {
      getState: () => ({ logEpoch: "same-runtime-epoch" }),
      getStatus: () => status,
      getSessions: () => sessions,
      subscribe(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
    notifications,
    publish(phase, nextStatus = "live") {
      sessions = [summary(phase)];
      status = nextStatus;
      for (const callback of listeners) callback();
    },
  };
  const props = {
    workspacePath: join(sandbox, "workspace"),
    enabled: true,
    rpcReady: true,
    platform: {
      showTaskNotification(payload) {
        notifications.push(payload);
      },
    },
    formatMessage: english,
  };
  function Observer({ params }) {
    useWorkspaceTerminalTaskNotifications(params);
    return null;
  }
  globalThis.subscriptionAudit = audit;
  root = createRoot(document.getElementById("root"));
  await act(async () => root.render(createElement(Observer, { params: props })));
  audit.setLanguage = async (formatMessage) => {
    props.formatMessage = formatMessage;
    await act(async () => root.render(createElement(Observer, { params: { ...props } })));
  };
  return audit;
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = undefined;
});
after(() => {
  dom.window.close();
  delete globalThis.subscriptionAudit;
  for (const [key, value] of previous) {
    if (value) Object.defineProperty(globalThis, key, value);
    else delete globalThis[key];
  }
});

test("同代际重连保留已观察运行，完成后恰好一次", async () => {
  const audit = await fixture();
  await act(async () => audit.publish("running", "connecting"));
  await act(async () => audit.publish("completedSuccess"));
  assert.equal(audit.notifications.length, 1);
});
test("live 状态切语言，后续完成使用新语言且只发一次", async () => {
  const audit = await fixture();
  await audit.setLanguage(chinese);
  await act(async () => audit.publish("completedSuccess"));
  await act(async () => audit.publish("completedSuccess"));
  assert.equal(audit.notifications.length, 1);
  assert.equal(audit.notifications[0].title, "zh:notification.completed");
});
test("同代际重连中切语言，恢复完成仍使用新语言补投一次", async () => {
  const audit = await fixture();
  await act(async () => audit.publish("running", "connecting"));
  await audit.setLanguage(chinese);
  await act(async () => audit.publish("completedSuccess"));
  await act(async () => audit.publish("completedSuccess"));
  assert.equal(audit.notifications.length, 1);
  assert.equal(audit.notifications[0].title, "zh:notification.completed");
});
