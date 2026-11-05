import assert from "node:assert/strict";
import test from "node:test";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";
import { runSourceTests } from "./source-test-runner.mjs";

const component = "packages/ui/src/project-workflow/useWorkflowRunSave.ts";
const entry = { name: "audit-workflow", scope: "project" };

test("开发文档stdio旧请求迟到不能覆盖Reload已提交的新记录", async () => {
  let releaseOld;
  const old = new Promise((resolveOld) => {
    releaseOld = resolveOld;
  });
  let count = 0,
    state;
  const trafficRequestRef = { current: 0 };
  const trafficSourceRef = { current: "real" };
  const reload = await loadComponentCallback(
    "apps/dev-docs/src/docs-view/adapters/useStdioTraffic.ts",
    "fetchRealTraffic",
    {
      trafficRequestRef,
      trafficSourceRef,
      fetch: async () => ({
        ok: true,
        json: async () =>
          ++count === 1
            ? old
            : {
                status: "ready",
                logDir: "/audit/stdio",
                records: [{ index: 2, record: { raw: "audit-new" } }],
              },
      }),
      setRealTraffic: (next) => {
        state = typeof next === "function" ? next(state) : next;
      },
    },
  );
  const previous = reload();
  await reload();
  releaseOld({
    status: "ready",
    logDir: "/audit/stdio",
    records: [{ index: 1, record: { raw: "audit-old" } }],
  });
  await previous;
  assert.equal(state.records[0].record.raw, "audit-new");
});

test("开发文档stdio过期失败与模式/卸载失效均不能回写", async () => {
  for (const invalidation of ["newer", "mock", "inactive"]) {
    let rejectOld,
      calls = 0,
      state = { status: "ready", records: [] };
    const pending = new Promise((_, reject) => {
      rejectOld = reject;
    });
    const trafficRequestRef = { current: 0 },
      trafficSourceRef = { current: "real" };
    const reload = await loadComponentCallback(
      "apps/dev-docs/src/docs-view/adapters/useStdioTraffic.ts",
      "fetchRealTraffic",
      {
        trafficRequestRef,
        trafficSourceRef,
        fetch: async () =>
          ++calls === 1
            ? pending
            : {
                ok: true,
                json: async () => ({
                  status: "ready",
                  logDir: "/audit/stdio",
                  records: [{ index: 2, record: { raw: "audit-new" } }],
                }),
              },
        setRealTraffic: (next) => {
          state = typeof next === "function" ? next(state) : next;
        },
      },
    );
    const first = reload();
    if (invalidation === "newer") await reload();
    else {
      trafficSourceRef.current = invalidation;
      trafficRequestRef.current++;
    }
    const accepted = state;
    rejectOld(new Error("synthetic stale failure"));
    await first;
    assert.equal(state, accepted, invalidation);
    if (invalidation !== "newer") {
      await reload();
      assert.equal(calls, 1);
    }
  }
});

test("开发文档stdio当前错误沿原状态面呈现", async () => {
  let state = { status: "ready", records: [{ index: 1 }] };
  const reload = await loadComponentCallback(
    "apps/dev-docs/src/docs-view/adapters/useStdioTraffic.ts",
    "fetchRealTraffic",
    {
      trafficRequestRef: { current: 0 },
      trafficSourceRef: { current: "real" },
      fetch: async () => {
        throw new Error("synthetic current failure");
      },
      setRealTraffic: (next) => {
        state = next(state);
      },
    },
  );
  await reload();
  assert.equal(state.status, "error");
  assert.equal(state.error, "synthetic current failure");
  assert.deepEqual(state.records, []);
});

test("E2E报告趋势tooltip读取解析的纵轴值，不能将raw点对象归零", async () => {
  const round = await loadComponentCallback(
    "packages/e2e-report/src/viewer/format.ts",
    "round",
    {},
  );
  const formatNumber = await loadComponentCallback(
    "packages/e2e-report/src/viewer/format.ts",
    "formatNumber",
    { round },
  );
  const options = await loadComponentCallback(
    "packages/e2e-report/src/viewer/ChartPanels.tsx",
    "buildLineOptions",
    {
      chartTextColor: () => "#fff",
      chartGridColor: () => "#333",
      formatNumber,
    },
  );
  for (const [unit, label, value] of [
    ["%", "CPU Total", 47.25],
    ["MB", "Memory", 128],
  ]) {
    const tooltip = options(unit).plugins.tooltip.callbacks.label;
    assert.equal(
      tooltip({ dataset: { label }, raw: { x: 3, y: value }, parsed: { x: 3, y: value } }),
      `${label}: ${value}${unit}`,
    );
    assert.equal(
      tooltip({ dataset: { label }, raw: { x: 3, y: null }, parsed: { x: 3, y: null } }),
      `${label}: n/a`,
    );
  }
});

test("开发文档 stdio 路径沿用当前 fork 数据根及环境优先级", async () => {
  const path = "apps/dev-docs/vite-adapters/stdioTrafficApiPlugin.ts";
  const source = ts.createSourceFile(
    path,
    await readFile(new URL("../../" + path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "STDIO_TRAFFIC_LOG_DIR")
      initializer = node.initializer.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(initializer);
  const evaluate = new Function("process", "homedir", "join", "return " + initializer);
  const root = resolve("audit-docs-data");
  for (const [env, expectedRoot] of [
    [{}, root],
    [{ HOME: root + "-home" }, root + "-home"],
    [
      { HOME: root + "-home", ZCODE_DATA_BASE_DIR: "  " + root + "-configured  " },
      root + "-configured",
    ],
    [{ HOME: "  ", ZCODE_DATA_BASE_DIR: "  " }, root],
  ])
    assert.equal(
      evaluate({ env }, () => root, join),
      join(expectedRoot, ".zcodium/v2/dev/stdio-traffic"),
    );
});

test("Stream Animate 静态服务拒绝与 dist 同前缀的兄弟目录", async () => {
  const chosen = [];
  const serve = await loadComponentCallback(
    "packages/stream-animate/src/server/http.ts",
    "serveStatic",
    {
      join,
      resolve,
      relative,
      isAbsolute,
      resolveStaticPath: async (candidate) => {
        chosen.push(candidate);
        return candidate;
      },
      contentTypeFor: () => "application/octet-stream",
      createReadStream: () => ({ pipe() {} }),
      sendNotFound: () => assert.fail("Unexpected not found"),
    },
  );
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "audit-stream");
  const response = { setHeader() {} };
  await serve(packageRoot, { url: "/assets/audit.js" }, response);
  await serve(packageRoot, { url: "/%2e%2e%2fdist-private%2faudit.txt" }, response);
  assert.deepEqual(chosen, [
    join(packageRoot, "dist/assets/audit.js"),
    join(packageRoot, "dist/index.html"),
  ]);
});

async function fixture({ host = {}, target, resolve = async () => ({ projectId: "project-a" }) }) {
  const state = { launches: [], resolutions: [] };
  const launch = await loadComponentCallback(component, "launch", {
    target,
    host,
    services: {
      windowProjectDirectory: {
        projectService: {
          resolveSessionDirectories: async (request) => {
            state.resolutions.push(request);
            return resolve(request);
          },
        },
      },
    },
    launcher: {
      launch: async (destination, request) => {
        state.launches.push({ destination, request });
        return { ok: true };
      },
    },
  });
  return { state, launch };
}

test("再次运行保留原会话的权威项目准入和完整远端目标", async () => {
  const target = {
    hostId: "host-a",
    workspacePath: "/audit/workspace",
    workspaceIdentity: "audit-identity-a",
    remoteSessionId: "attachment-a",
  };
  const f = await fixture({ host: { sessionId: "task-a" }, target });
  assert.deepEqual(await f.launch(entry, { count: 2 }), { ok: true });
  assert.deepEqual(f.state.resolutions, [{ ...target, taskId: "task-a" }]);
  assert.deepEqual(f.state.launches, [
    {
      destination: { ...target, projectId: "project-a" },
      request: { name: entry.name, scope: entry.scope, args: { count: 2 } },
    },
  ]);
});

test("显式选择另一个项目原样交付，不重新从原会话解析", async () => {
  const f = await fixture({
    host: { sessionId: "task-a" },
    target: { workspacePath: "/audit/shared" },
  });
  const selected = {
    projectId: "project-b",
    hostId: "host-b",
    workspacePath: "/audit/shared",
    workspaceIdentity: "audit-identity-b",
    remoteSessionId: "attachment-b",
  };
  await f.launch(entry, {}, selected);
  assert.deepEqual(f.state.resolutions, []);
  assert.deepEqual(f.state.launches[0].destination, selected);
});

test("无原会话时保留已知目标项目，不按路径补推归属", async () => {
  const target = { workspacePath: "/audit/shared", projectId: "project-c", hostId: "local" };
  const f = await fixture({ target });
  await f.launch(entry, {});
  assert.deepEqual(f.state.launches[0].destination, target);
  assert.deepEqual(f.state.resolutions, []);
});

test("无项目绑定的 null 与解析失败均保持既有准入边界", async () => {
  const f = await fixture({
    host: { sessionId: "task-outside" },
    target: { workspacePath: "/audit/shared" },
    resolve: async () => ({ projectId: null }),
  });
  await f.launch(entry, {});
  assert.equal(f.state.launches[0].destination.projectId, null);
  const rejected = await fixture({
    host: { sessionId: "task-deleted" },
    target: { workspacePath: "/audit/shared" },
    resolve: async () => {
      throw new Error("project-unavailable");
    },
  });
  await assert.rejects(rejected.launch(entry, {}), /project-unavailable/);
  assert.deepEqual(rejected.state.launches, []);
});

async function imageDownloadFixture() {
  return loadComponentCallback(
    "packages/ui/src/components/ai-elements/image-preview-dialog.tsx",
    "downloadImagePreview",
    {
      isHttpSource: (value) => /^https?:/.test(value),
      imageDownloadFilename: () => "audit-image.png",
      readBoundedImageBlob: async () => new Blob([new Uint8Array([1, 2, 3])]),
      ImageDownloadError: class extends Error {},
    },
  );
}

test("HTTP 图片的浏览器下载成功返回 started，不要求本机磁盘 path", async () => {
  const download = await imageDownloadFixture();
  const result = await download(
    { src: "https://example.invalid/audit-image.png", alt: "audit-image" },
    async () => ({ success: true, downloadStarted: true, name: "audit-image.png" }),
  );
  assert.deepEqual(result, { kind: "started" });
});

test("data/blob 图片读取字节后同样采用浏览器下载语义", async () => {
  const download = await imageDownloadFixture();
  let payload;
  const result = await download(
    { src: "blob:audit-image", alt: "audit-image" },
    async (request) => {
      payload = request;
      return { success: true, downloadStarted: true };
    },
  );
  assert.deepEqual(new Uint8Array(payload.data), new Uint8Array([1, 2, 3]));
  assert.deepEqual(result, { kind: "started" });
});

test("桌面真实路径保存、取消与无结果证据继续保持原边界", async () => {
  const download = await imageDownloadFixture();
  const image = { src: "https://example.invalid/audit-image.png", alt: "audit-image" };
  assert.deepEqual(
    await download(image, async () => ({ success: true, path: "/audit/image.png" })),
    {
      kind: "saved",
      path: "/audit/image.png",
    },
  );
  assert.deepEqual(await download(image, async () => ({ success: false, canceled: true })), {
    kind: "canceled",
  });
  await assert.rejects(
    download(image, async () => ({ success: false, error: "save_failed" })),
    /save_failed/,
  );
  await assert.rejects(
    download(image, async () => ({ success: true })),
    /save_failed/,
  );
});

test("手机 browser adapter 明确标记下载交付，不伪造磁盘路径", async () => {
  const state = { clicked: false, removed: false, revoked: [], timers: [] };
  const save = await loadComponentCallback(
    "packages/web/src/platform/saveBrowserFile.ts",
    "saveBrowserFile",
    {
      MAX_DOWNLOAD_BYTES: 50 * 1024 * 1024,
      DOWNLOAD_URL_RETENTION_MS: 40_000,
      URL: {
        createObjectURL: () => "blob:audit-download",
        revokeObjectURL: (url) => state.revoked.push(url),
      },
      document: {
        createElement: () => ({
          click: () => {
            state.clicked = true;
          },
          remove: () => {
            state.removed = true;
          },
        }),
        body: { appendChild: () => {} },
      },
      setTimeout: (fn, delay) => {
        state.timers.push({ fn, delay });
      },
    },
  );
  const result = await save({ data: new ArrayBuffer(0), suggestedName: "../audit:image.png" });
  assert.deepEqual(result, { success: true, downloadStarted: true, name: "audit_image.png" });
  assert.equal(state.clicked, true);
  assert.equal(state.removed, true);
  assert.equal(state.timers.length, 1);
  assert.equal(state.revoked.length, 0);
  state.timers[0].fn();
  assert.deepEqual(state.revoked, ["blob:audit-download"]);
});

test("受限 CEL 真实 compiler/evaluator 的正负零回归", async (t) => {
  const result = await runSourceTests([
    "scripts/ci/fixtures/full-code-audit-model-options.test.mjs",
  ]);
  assert.equal(result.tests, 2);
  t.diagnostic(result.logPath);
});

async function streamDetailFixture({ selected = "run-a", fetch } = {}) {
  const state = { run: null, lines: [], writes: 0, error: null };
  const selectedRunIdRef = { current: selected };
  const selectedRequestRef = { current: 0 };
  const runsDetailVersionRef = { current: 0 },
    runDetailVersionsRef = { current: new Map() };
  const refresh = await loadComponentCallback(
    "packages/stream-animate/src/App.tsx",
    "refreshSelectedRun",
    {
      selectedRunIdRef,
      selectedRequestRef,
      runsDetailVersionRef,
      runDetailVersionsRef,
      fetchRun: fetch ?? (async (id) => ({ id })),
      fetchRawLines: async (id) => [id],
      setSelectedRun: (run) => {
        state.run = run;
        state.writes++;
      },
      setRawLines: (lines) => {
        state.lines = lines;
      },
      setRuns: () => {},
      setError: (error) => {
        state.error = error;
      },
      toErrorMessage: (error) => error.message,
    },
  );
  return { state, selectedRunIdRef, selectedRequestRef, refresh };
}

test("stream profiler 切换 B 后 A 迟到不能覆盖 B 的详情和原始输出", async () => {
  const gate = Promise.withResolvers();
  const f = await streamDetailFixture({
    fetch: async (id) => (id === "run-a" ? gate.promise : { id }),
  });
  const first = f.refresh("run-a");
  f.selectedRunIdRef.current = "run-b";
  await f.refresh("run-b");
  gate.resolve({ id: "run-a" });
  await first;
  assert.equal(f.state.run.id, "run-b");
  assert.deepEqual(f.state.lines, ["run-b"]);
  assert.equal(f.state.writes, 1);
});

test("stream profiler 同 run 轮询乱序只接受最新请求", async () => {
  const gate = Promise.withResolvers();
  let calls = 0;
  const f = await streamDetailFixture({
    fetch: async () => (++calls === 1 ? gate.promise : { id: "run-a", revision: 2 }),
  });
  const first = f.refresh("run-a");
  await f.refresh("run-a");
  gate.resolve({ id: "run-a", revision: 1 });
  await first;
  assert.equal(f.state.run.revision, 2);
  assert.equal(f.state.writes, 1);
});

test("stream profiler 卸载作废与当前读取失败保持状态边界", async () => {
  const gate = Promise.withResolvers();
  const stale = await streamDetailFixture({ fetch: () => gate.promise });
  const first = stale.refresh("run-a");
  stale.selectedRequestRef.current++;
  gate.resolve({ id: "run-a" });
  await first;
  assert.equal(stale.state.writes, 0);
  const failed = await streamDetailFixture({
    fetch: async () => {
      throw new Error("audit-read-failed");
    },
  });
  await failed.refresh("run-a");
  assert.equal(failed.state.error, "audit-read-failed");
  assert.equal(failed.state.writes, 0);
});

test("stream profiler 列表乱序与刷新失败不会产生未处理 rejection", async () => {
  const gate = Promise.withResolvers();
  let calls = 0;
  const state = { runs: [], error: null };
  const runsRequestRef = { current: 0 };
  const runsDetailVersionRef = { current: 0 },
    runDetailVersionsRef = { current: new Map() };
  const refresh = await loadComponentCallback(
    "packages/stream-animate/src/App.tsx",
    "refreshRuns",
    {
      runsRequestRef,
      runsDetailVersionRef,
      runDetailVersionsRef,
      fetchRuns: () => (++calls === 1 ? gate.promise : Promise.resolve([{ id: "new" }])),
      setSelectedRunId: () => {},
      setRuns: (runs) => {
        state.runs = typeof runs === "function" ? runs(state.runs) : runs;
      },
      setError: (error) => {
        state.error = error;
      },
      toErrorMessage: (error) => error.message,
    },
  );
  const first = refresh();
  await refresh();
  gate.resolve([{ id: "old" }]);
  await first;
  assert.deepEqual(state.runs, [{ id: "new" }]);
  const failed = await loadComponentCallback("packages/stream-animate/src/App.tsx", "refreshRuns", {
    runsRequestRef,
    runsDetailVersionRef,
    runDetailVersionsRef,
    fetchRuns: async () => {
      throw new Error("audit-list-failed");
    },
    setRuns: () => assert.fail("failed read must not commit"),
    setError: (error) => {
      state.error = error;
    },
    toErrorMessage: (error) => error.message,
  });
  await failed();
  assert.equal(state.error, "audit-list-failed");
});

test("stream同批旧列表不能将已接受的completed详情退回running，其他run仍刷新", async () => {
  const gate = Promise.withResolvers();
  const state = { runs: [{ id: "run-a", status: "running" }] };
  const dependencies = {
    runsRequestRef: { current: 0 },
    selectedRunIdRef: { current: "run-a" },
    selectedRequestRef: { current: 0 },
    runsDetailVersionRef: { current: 0 },
    runDetailVersionsRef: { current: new Map() },
    fetchRuns: () => gate.promise,
    setSelectedRunId: () => {},
    fetchRun: async () => ({ id: "run-a", status: "completed" }),
    fetchRawLines: async () => [],
    setSelectedRun: () => {},
    setRawLines: () => {},
    setRuns: (next) => {
      state.runs = typeof next === "function" ? next(state.runs) : next;
    },
    setError: () => assert.fail("unexpected error"),
    toErrorMessage: (error) => error.message,
  };
  const list = await loadComponentCallback(
    "packages/stream-animate/src/App.tsx",
    "refreshRuns",
    dependencies,
  );
  const detail = await loadComponentCallback(
    "packages/stream-animate/src/App.tsx",
    "refreshSelectedRun",
    dependencies,
  );
  const old = list();
  await detail("run-a");
  gate.resolve([
    { id: "run-a", status: "running" },
    { id: "run-b", status: "completed" },
  ]);
  await old;
  assert.deepEqual(state.runs, [
    { id: "run-a", status: "completed" },
    { id: "run-b", status: "completed" },
  ]);
});

async function initialStreamEffect(dependencies) {
  const source = ts.createSourceFile(
    "App.tsx",
    await readFile(new URL("../../packages/stream-animate/src/App.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let callback;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useEffect" &&
      node.arguments[0]?.getText(source).includes("fetchConfig")
    )
      callback = node.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback);
  const { outputText } = ts.transpileModule("const callback=" + callback + ";", {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  });
  return new Function(...Object.keys(dependencies), outputText + "return callback;")(
    ...Object.values(dependencies),
  );
}

test("stream初始化旧失败不覆盖刷新，首次接受列表完成默认选择，config独立保留", async () => {
  const gate = Promise.withResolvers();
  let count = 0,
    error = null,
    config = null,
    selected = null;
  const refs = {
    runsRequestRef: { current: 0 },
    runsDetailVersionRef: { current: 0 },
    runDetailVersionsRef: { current: new Map() },
  };
  const dependencies = {
    ...refs,
    fetchConfig: async () => ({ hasEnvApiKey: false }),
    fetchRuns: () => (++count === 1 ? gate.promise : Promise.resolve([{ id: "new" }])),
    setConfig: (next) => (config = next),
    setRuns: () => {},
    setSelectedRunId: (next) => {
      selected = typeof next === "function" ? next(selected) : next;
    },
    setError: (next) => (error = next),
    toErrorMessage: (value) => value.message,
  };
  const refreshRuns = await loadComponentCallback(
    "packages/stream-animate/src/App.tsx",
    "refreshRuns",
    dependencies,
  );
  const initialize = await initialStreamEffect({ ...dependencies, refreshRuns });
  initialize();
  await refreshRuns();
  gate.reject(new Error("synthetic stale initial failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(error, null);
  assert.deepEqual(config, { hasEnvApiKey: false });
  assert.equal(selected, "new");
  selected = "manual-selection";
  await refreshRuns();
  assert.equal(selected, "manual-selection");
});
