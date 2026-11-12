import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import React, { act, createContext, useContext, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { assertProjectPath, projectRoot } from "../project-test-sandbox.mjs";

const mainPath = "packages/web/src/mobile/main.tsx";
const providerPath = "packages/ui/src/v4/V4ConversationContext.tsx";
const layerPath = "packages/ui/src/v4/sessionDataLayer.ts";
const projectionPath = "packages/ui/src/v4/conversationProjectionStore.ts";

async function ast(path) {
  const fullPath = await assertProjectPath(join(projectRoot, path));
  return ts.createSourceFile(path, await readFile(fullPath, "utf8"), ts.ScriptTarget.Latest, true);
}

function one(source, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1, "expected one current lifecycle source node");
  return matches[0];
}

function compile(code, ports) {
  const { outputText } = ts.transpileModule(code, {
    fileName: "actual-mobile-lifecycle.tsx",
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
    },
  });
  return new Function(...Object.keys(ports), outputText)(...Object.values(ports));
}

// 使用真实 Layer、ProjectionStore、行池与协议函数；日志是无 IO 的诊断端口。
async function loadDataSource() {
  const directory = await assertProjectPath(join(process.env.TEMP, "mobile-business-lifecycle"));
  await mkdir(directory, { recursive: true });
  const result = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(join(projectRoot, layerPath))};
export {ConversationProjectionStore} from ${JSON.stringify(join(projectRoot, projectionPath))};`,
      sourcefile: "actual-session-data-source.ts",
      resolveDir: projectRoot,
      loader: "ts",
    },
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "node",
    external: ["react", "react-dom", "react-dom/*"],
    alias: {
      "@": join(projectRoot, "packages/ui/src"),
      "@zcode/shared": join(projectRoot, "packages/shared/src/index.ts"),
      "@zcode/shared/zcode-protocol-v4": join(
        projectRoot,
        "packages/shared/src/zcode-protocol-v4/index.ts",
      ),
    },
    logLevel: "silent",
    plugins: [
      {
        name: "lifecycle-diagnostic-port",
        setup(builder) {
          builder.onResolve({ filter: /^@\/logger\.js$/ }, () => ({
            path: "logger-port",
            namespace: "lifecycle-port",
          }));
          builder.onLoad({ filter: /.*/, namespace: "lifecycle-port" }, () => ({
            contents: `const level={info(){},warn(){},error(){},debug(){}};
export const logger={...level,lifecycle:level};
export function logMemoryDiagnostics(){}`,
            loader: "js",
          }));
        },
      },
    ],
  });
  const inputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll("\\", "/"));
  for (const path of [layerPath, projectionPath, "packages/ui/src/v4/conversationRowSharing.ts"])
    assert.ok(
      inputs.some((input) => input.endsWith(path)),
      "actual lifecycle source required",
    );
  assert.equal(
    inputs.some((input) => /packages\/(?:ui|shared)\/dist\//.test(input)),
    false,
  );
  const target = await assertProjectPath(join(directory, "source.mjs"));
  await writeFile(target, result.outputFiles[0].text);
  return import(pathToFileURL(target).href);
}

export async function loadBusinessRootSource() {
  const [main, provider, data] = await Promise.all([
    ast(mainPath),
    ast(providerPath),
    loadDataSource(),
  ]);
  const render = one(
    main,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "render",
  );
  assert.equal(render.arguments.length, 1);
  const context = one(
    provider,
    (node) =>
      ts.isVariableDeclaration(node) && node.name.getText(provider) === "V4ConversationContext",
  );
  const ready = one(
    provider,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "ReadyV4ConversationProvider",
  );
  return {
    ...data,
    createProvider(createTransport) {
      return compile(
        `const ${context.getText(provider)};
${ready.getText(provider)}
return {Provider:ReadyV4ConversationProvider,Context:V4ConversationContext};`,
        {
          React,
          createContext,
          useMemo,
          useEffect,
          SessionDataLayer: data.SessionDataLayer,
          usePlatform: () => ({}),
          ServiceProvider: ({ children }) => children,
          createAgentConversationTransport: createTransport,
        },
      );
    },
    renderEntry(MobileApp) {
      // 不合成期望入口：直接执行当前 main.tsx 传给 ReactDOM.render 的原表达式。
      return compile(`return (${render.arguments[0].getText(main)});`, {
        React,
        StrictMode: React.StrictMode,
        MobileApp,
      });
    },
  };
}

function createTransport() {
  const listeners = { frame: new Set(), assembly: new Set(), restart: new Set() };
  const calls = { subscriptions: [], activated: [], unsubscribed: [] };
  const listen = (key) => (listener) => {
    listeners[key].add(listener);
    return () => listeners[key].delete(listener);
  };
  return {
    listeners,
    calls,
    onFrame: listen("frame"),
    onAssemblyFault: listen("assembly"),
    onRuntimeRestart: listen("restart"),
    async subscribe(params) {
      calls.subscriptions.push(params);
      return {
        ack: {
          subscriptionId: `source-subscription-${calls.subscriptions.length}`,
          mode: "snapshot",
          logEpoch: "source-epoch",
          seq0: 0,
        },
      };
    },
    activate(subscriptionId) {
      calls.activated.push(subscriptionId);
    },
    async unsubscribe(subscriptionId) {
      calls.unsubscribed.push(subscriptionId);
    },
  };
}

export async function createBusinessFixture(source) {
  const dom = new JSDOM("<div id='mobile-root'></div>", { pretendToBeVisual: true });
  const globals = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const state = { transports: [], bundle: null, lease: null, failureCode: null, unhandled: [] };
  const onUnhandled = () => state.unhandled.push("ASYNC_REJECTION");
  process.on("unhandledRejection", onUnhandled);
  const { Provider, Context } = source.createProvider(() => {
    const transport = createTransport();
    state.transports.push(transport);
    return transport;
  });
  const services = { zcodeAgentService: {} };
  function Chat() {
    const bundle = useContext(Context);
    const lease = useMemo(() => bundle.layer.acquire("source-session"), [bundle]);
    state.lease = lease;
    useEffect(() => () => lease.release(), [lease]);
    return React.createElement("main", { "data-page": "chat" });
  }
  function Observe({ children }) {
    state.bundle = useContext(Context);
    return children;
  }
  function MobileApp() {
    const [chat, setChat] = useState(false);
    const content = React.createElement(
      Provider,
      { workspacePath: "source-workspace", services, remoteSessionId: null },
      React.createElement(
        Observe,
        null,
        React.createElement(
          "button",
          { "data-action": "navigate", onClick: () => setChat((value) => !value) },
          chat ? "home" : "chat",
        ),
        chat ? React.createElement(Chat) : React.createElement("main", { "data-page": "home" }),
      ),
    );
    return React.createElement(Boundary, null, content);
  }
  class Boundary extends React.Component {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    render() {
      return this.state.failed
        ? React.createElement("output", { "data-failure": "caught" })
        : this.props.children;
    }
  }
  const root = createRoot(dom.window.document.getElementById("mobile-root"), {
    onCaughtError(error) {
      state.failureCode =
        error?.message === "SessionDataLayer 已释放，不能再 acquire"
          ? "SESSION_DATA_LAYER_DISPOSED"
          : "UNEXPECTED_RENDER_ERROR";
    },
  });
  let unmounted = false;
  async function settle() {
    await act(async () => {
      await immediate();
    });
  }
  return {
    state,
    document: dom.window.document,
    async mount(actual = true) {
      const entry = actual ? source.renderEntry(MobileApp) : React.createElement(MobileApp);
      // 错误边界留在业务组件内；外包真实入口会把根 StrictMode 变成局部模式，漏测初始重放。
      await act(async () => root.render(entry));
      await settle();
    },
    async navigate() {
      const button = dom.window.document.querySelector("[data-action='navigate']");
      assert.ok(button, "expected actual React navigation control");
      await act(async () =>
        button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })),
      );
      await settle();
    },
    async unmount() {
      if (unmounted) return;
      unmounted = true;
      await act(async () => root.unmount());
      await settle();
    },
    async close() {
      try {
        if (!unmounted) await this.unmount();
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
        dom.window.close();
        for (const [key, descriptor] of globals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete globalThis[key];
        }
      }
    },
  };
}

export function trackKeepWarmTimers(delay) {
  const pending = new Set();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => {
    const timer = originalSet(() => {
      pending.delete(timer);
      callback(...args);
    }, ms);
    if (ms === delay) pending.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    pending.delete(timer);
    return originalClear(timer);
  };
  return {
    pending,
    restore() {
      for (const timer of pending) originalClear(timer);
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    },
  };
}
