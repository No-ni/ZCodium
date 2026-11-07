"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const repository = path.resolve(__dirname, "../../../..");
const hookPath = path.join(repository, "docs/testing/qa-2026-11-06/qa-project-bootstrap.cjs");
const observerPath = path.join(
  repository,
  "docs/testing/qa-2026-11-06/qa-composer-fit-observer.ts",
);
const evidencePath = path.join(__dirname, "feature-inventory-composer-fit-hook-preflight.json");

async function safe(candidate) {
  const absolute = path.resolve(candidate);
  const relative = path.relative(repository, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Probe escapes worktree");
  for (let cursor = absolute; ; cursor = path.dirname(cursor)) {
    try {
      const item = await fs.lstat(cursor);
      if (
        item.isSymbolicLink() ||
        (await fs.realpath(cursor)).toLowerCase() !== cursor.toLowerCase()
      )
        throw new Error("Probe refuses reparse/redirected ancestor");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (cursor.toLowerCase() === repository.toLowerCase()) break;
  }
  return absolute;
}

(async () => {
  for (const candidate of [hookPath, observerPath, evidencePath]) await safe(candidate);
  const source = await fs.readFile(hookPath, "utf8");
  const counters = {
    browser: 0,
    dynamicImports: 0,
    auditProcesses: 0,
    pathAudits: 0,
    fileReads: 0,
    fileWrites: 0,
  };
  const forbid = (name) => () => {
    counters[name]++;
    throw new Error("Excluded-context probe reached " + name);
  };
  const syncFs = require("node:fs");
  const guardedFs = new Proxy(syncFs, {
    get(target, property) {
      if (property === "readFileSync")
        return (...args) => {
          counters.fileReads++;
          return target.readFileSync(...args);
        };
      if (["existsSync", "lstatSync", "realpathSync", "statSync"].includes(property))
        return forbid("pathAudits");
      if (["writeFileSync", "mkdirSync", "rmSync", "openSync"].includes(property))
        return forbid("fileWrites");
      return target[property];
    },
  });
  const guardedPromises = new Proxy(
    {},
    {
      get() {
        return forbid("fileWrites");
      },
    },
  );
  const desktopRequire = forbid("dynamicImports");
  desktopRequire.resolve = forbid("dynamicImports");
  const originalBeforeAll = async function originalBeforeAll() {};
  const originalBeforeEach = async function originalBeforeEach() {};
  const originalAfterEach = async function originalAfterEach() {};
  const originalAfterAll = async function originalAfterAll() {};
  const browser = {
    options: {
      mochaOpts: {
        rootHooks: {
          beforeAll: [originalBeforeAll],
          beforeEach: [originalBeforeEach],
          afterEach: [originalAfterEach],
          afterAll: [originalAfterAll],
        },
      },
    },
    execute: forbid("browser"),
    saveScreenshot: forbid("browser"),
    takeScreenshot: forbid("browser"),
    waitUntil: forbid("browser"),
  };
  const sandbox = {
    exports: {},
    __dirname: path.dirname(hookPath),
    __filename: hookPath,
    process: { platform: "win32", env: {}, pid: process.pid },
    browser,
    require(name) {
      if (name === "node:fs") return guardedFs;
      if (name === "node:fs/promises") return guardedPromises;
      if (name === "node:module") return { createRequire: () => desktopRequire };
      if (name === "node:child_process") return { execFileSync: forbid("auditProcesses") };
      return require(name);
    },
  };
  new vm.Script(source, { filename: hookPath }).runInNewContext(sandbox);
  // Module initialization only reads the hook for its SHA. Excluded calls are measured independently.
  const moduleInitializationReads = counters.fileReads;
  for (const key of Object.keys(counters)) counters[key] = 0;
  const hooks = sandbox.exports.mochaHooks();
  const order = Object.fromEntries(
    Object.entries(hooks).map(([key, functions]) => [key, functions.map((fn) => fn.name)]),
  );
  const expectedOrder = {
    beforeAll: ["originalBeforeAll", "bootstrapProject"],
    beforeEach: [
      "originalBeforeEach",
      "beginReloadObservationBeforeEach",
      "beginComposerFitObservationBeforeEach",
    ],
    afterAll: ["originalAfterAll"],
    afterEach: [
      "finishReloadObservationAfterEach",
      "finishComposerFitObservationAfterEach",
      "observeSpfv002AfterEach",
      "originalAfterEach",
    ],
  };
  const targetFile = path.join(
    repository,
    "packages/desktop/test/e2e/conversation-session/conversation-session-v4-composer-toolbar.test.ts",
  );
  const targetTitle =
    "keeps the open model picker responsive when the composer shrinks and expands";
  const excluded = [
    {},
    {
      currentTest: {
        title: "completed task 的 picker 不跨 scope 自动弹到新 draft",
        file: targetFile,
      },
    },
    {
      currentTest: {
        title: targetTitle,
        file: path.join(repository, "docs/testing/wrong.test.ts"),
      },
    },
  ];
  for (const context of excluded) {
    await hooks.beforeEach.at(-1).call(context);
    await hooks.afterEach[1].call(context);
  }
  const missingBaselineBrowser = sandbox.browser;
  sandbox.browser = {};
  let missingBaselineRejected = false;
  try {
    sandbox.exports.mochaHooks();
  } catch (error) {
    missingBaselineRejected = /refuses to replace or bypass/.test(error.message);
  }
  sandbox.browser = missingBaselineBrowser;
  const allPassed =
    JSON.stringify(order) === JSON.stringify(expectedOrder) &&
    missingBaselineRejected &&
    moduleInitializationReads === 1 &&
    Object.values(counters).every((value) => value === 0);
  const evidence = {
    capturedAt: new Date().toISOString(),
    node: process.version,
    evidenceKind:
      "Read-only CJS VM parse and actual exported hook arrays; excluded fit hooks only. No UI/build, reload/bootstrap/target hooks not invoked.",
    hookPath,
    observerPath,
    hookSourceSha256: createHash("sha256").update(source).digest("hex"),
    observerSourceSha256: createHash("sha256")
      .update(await fs.readFile(observerPath))
      .digest("hex"),
    moduleInitializationReads,
    order,
    expectedOrder,
    missingBaselineRejected,
    excludedContexts: excluded.length,
    excludedHookCalls: excluded.length * 2,
    counters,
    allPassed,
  };
  await fs.writeFile(await safe(evidencePath), JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ evidencePath, allPassed, counters }) + "\n");
  if (!allPassed) process.exitCode = 1;
})().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
