"use strict";

// 本轮外置 QA 前置：保留正式 spec/replay，经过真实项目 UI 只创建合成测试项目。
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");

const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const repository = path.resolve(__dirname, "../../..");
const desktop = path.join(repository, "packages", "desktop");
const desktopRequire = createRequire(path.join(desktop, "package.json"));
const hookSourceSha256 = createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
let bootstrapInvocationCounter = 0;
const { insideWorktree, auditWindowsReparsePoints, isolatedPaths } =
  require("./bootstrap-path-guards.cjs").createBootstrapPathGuards({
    repository,
    fixtureDirectory: __dirname,
    desktopRequire,
  });

function readSnapshot(paths) {
  const settings = JSON.parse(fs.readFileSync(paths.settings, "utf8"));
  const db = new DatabaseSync(paths.database, { readOnly: true });
  try {
    return {
      capturedAt: new Date().toISOString(),
      evidenceKind: "read-only synthetic E2E fixture; not real user data",
      database: paths.database,
      settings: paths.settings,
      nodeOptions: paths.nodeOptions,
      lastWorkspaceSession: settings.lastWorkspaceSession ?? [],
      projects: db
        .prepare("SELECT project_id,host_id,name,name_overridden,deleted FROM projects")
        .all(),
      projectRoots: db
        .prepare("SELECT project_id,root_path,position,is_primary FROM project_roots")
        .all(),
      migrations: db
        .prepare("SELECT id,checksum,app_version,time_applied FROM schema_migration")
        .all(),
    };
  } finally {
    db.close();
  }
}

async function bootstrapProject() {
  this.timeout(120_000);
  const paths = isolatedPaths();
  const browser = globalThis.browser;
  const workerId = (process.env.WDIO_WORKER_ID || String(process.pid)).replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const invocation = {
    counter: ++bootstrapInvocationCounter,
    processId: process.pid,
    startedAt: new Date().toISOString(),
    timestamp: Date.now(),
    hookSourceSha256,
  };
  const artifactStem = path.join(
    paths.artifacts,
    "qa-project-bootstrap-" +
      workerId +
      "-" +
      String(invocation.counter).padStart(3, "0") +
      "-" +
      invocation.processId +
      "-" +
      invocation.timestamp,
  );
  await fsp.mkdir(paths.artifacts, { recursive: true });
  const screenshot = async (suffix) => {
    const target = insideWorktree(artifactStem + suffix);
    // 每次 invocation 独立且独占预留，不能覆盖首次 missingProject 的证据。
    const reserved = await fsp.open(target, "wx");
    await reserved.close();
    await browser.saveScreenshot(target);
  };
  await screenshot("-onload.png");
  // tsImport 复用本地 tsx；缓存/临时根已审查。正式 helper 保持原文件与公开入口。
  const { tsImport } = desktopRequire("tsx/esm/api");
  const importHelper = (name) =>
    tsImport(pathToFileURL(path.join(desktop, "test", "e2e", "helpers", name + ".ts")).href, {
      parentURL: pathToFileURL(__filename).href,
      tsconfig: path.join(desktop, "tsconfig.e2e.json"),
    });
  const app = await importHelper("desktop-app");
  const sidebar = await importHelper("project-sidebar");
  const onboarding = await importHelper("occupation-onboarding");
  if (path.resolve(app.DEFAULT_WORKSPACE) !== paths.workspace)
    throw new Error("QA helper workspace differs from isolated root");
  await onboarding.skipOccupationOnboardingIfPresent();
  await app.waitForWorkspaceApp(paths.workspace, 30_000);
  await screenshot("-before.png");
  const before = readSnapshot(paths);
  before.workerId = workerId;
  before.bootstrapInvocation = invocation;
  before.suites = (this.test?.parent?.suites || []).map((suite) => ({
    title: suite.title,
    file: suite.file,
  }));
  before.ui = await browser.execute(() => ({
    projects: Array.from(document.querySelectorAll("[data-project-id][data-project-name]")).map(
      (item) => ({ id: item.dataset.projectId, name: item.dataset.projectName }),
    ),
    projectSectionPresent: Boolean(document.querySelector('[data-testid="project-section"]')),
    activeWorkspacePath: window.__zcodeTabStoreE2E?.getState().activeWorkspacePath ?? null,
  }));
  await fsp.writeFile(
    insideWorktree(artifactStem + "-before.json"),
    JSON.stringify(before, null, 2),
    { flag: "wx" },
  );
  const rowSelector = sidebar.projectRowSelector(paths.workspace);
  let exists = await browser.execute(
    (selector) => Boolean(document.querySelector(selector)),
    rowSelector,
  );
  if (!exists) {
    const section = globalThis.$('[data-testid="project-section"]');
    await section.waitForDisplayed({ timeout: 15_000 });
    await section.moveTo();
    await globalThis.$('[data-testid="virtual-project-add"]').click();
    const name = globalThis.$('[data-testid="virtual-project-name"]');
    await name.waitForDisplayed({ timeout: 15_000 });
    await name.setValue("ZCodeProject");
    await sidebar.selectNativeProjectDirectories([paths.workspace]);
    await globalThis.$('[data-testid="virtual-project-save"]').click();
    const trust = globalThis.$('[data-testid="project-folder-trust-confirm"]');
    await trust.waitForDisplayed({ timeout: 15_000 });
    const trustedPaths = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="project-folder-trust-path"]')).map(
        (item) => item.textContent.trim(),
      ),
    );
    if (trustedPaths.length !== 1 || path.resolve(trustedPaths[0]) !== paths.workspace)
      throw new Error("QA trust dialog contains an unexpected root");
    await trust.click();
    await name.waitForExist({ reverse: true, timeout: 30_000 });
    await sidebar.waitForProjectRow(paths.workspace, { timeout: 30_000 });
  }
  const after = readSnapshot(paths);
  after.workerId = workerId;
  after.bootstrapInvocation = invocation;
  const project = after.projects.find(
    (item) => item.host_id === "local" && item.name === "ZCodeProject" && !item.deleted,
  );
  if (
    !project ||
    !after.projectRoots.some(
      (root) =>
        root.project_id === project.project_id &&
        path.resolve(root.root_path) === paths.workspace &&
        root.is_primary === 1,
    )
  ) {
    throw new Error("QA project owner did not persist the isolated primary root");
  }
  await sidebar.startDraftFromProject(paths.workspace);
  await app.waitForWorkspaceApp(paths.workspace, 30_000);
  // Browser 专项可从已展开的空面板起步，避开旧 helper 的 macOS-only 热键。
  if (process.env.QA_BOOTSTRAP_OPEN_SIDE_PANE === "1") {
    const visible = () =>
      browser.execute(() =>
        Boolean(
          document.querySelector(
            '[data-side-pane-open-tab-item="browser"], [data-side-pane-add-trigger]',
          ),
        ),
      );
    if (!(await visible())) await globalThis.$('[data-testid="side-pane-toggle"]').click();
    await browser.waitUntil(visible, {
      timeout: 15_000,
      timeoutMsg: "QA UI side pane toggle did not reveal launcher",
    });
  }
  after.createdByBootstrap = !exists;
  after.fixtureMutationOnly = true;
  await fsp.writeFile(
    insideWorktree(artifactStem + "-after.json"),
    JSON.stringify(after, null, 2),
    { flag: "wx" },
  );
  await screenshot("-after.png");
}

async function observeSpfv002AfterEach() {
  const test = this.currentTest;
  if (
    !test?.title?.startsWith("SPFV-E2E-002 ") ||
    !test.file
      ?.replaceAll("\\", "/")
      .endsWith("/packages/desktop/test/e2e/ui-shell/side-pane-full-view.test.ts")
  )
    return;
  const paths = isolatedPaths();
  const observerPath = insideWorktree(path.join(__dirname, "qa-spfv-observer.ts"));
  auditWindowsReparsePoints([observerPath]);
  const observerSourceSha256 = createHash("sha256")
    .update(fs.readFileSync(observerPath))
    .digest("hex");
  const { tsImport } = desktopRequire("tsx/esm/api");
  const observer = await tsImport(pathToFileURL(observerPath).href, {
    parentURL: pathToFileURL(__filename).href,
    tsconfig: path.join(desktop, "tsconfig.e2e.json"),
  });
  await observer.observeSpfv002(this, {
    artifacts: paths.artifacts,
    observerSourceSha256,
    hookSourceSha256,
  });
}

function loadReloadObserver() {
  const facade = insideWorktree(path.join(__dirname, "reload-observation.cjs"));
  const source = insideWorktree(path.join(__dirname, "qa-reload-observer.ts"));
  auditWindowsReparsePoints([facade, source]);
  return require(facade);
}

async function beginReloadObservationBeforeEach() {
  if (process.platform !== "win32" || !this.currentTest) return;
  const paths = isolatedPaths();
  await loadReloadObserver().beginReloadObservation(this, {
    artifacts: paths.artifacts,
    hookSourceSha256,
  });
}

async function finishReloadObservationAfterEach() {
  if (process.platform !== "win32" || !this.currentTest) return;
  await loadReloadObserver().finishReloadObservation(this);
}

function isComposerFitObservationTarget(context) {
  const test = context.currentTest;
  return (
    test?.title ===
      "keeps the open model picker responsive when the composer shrinks and expands" &&
    Boolean(
      test.file
        ?.replaceAll("\\", "/")
        .endsWith(
          "/packages/desktop/test/e2e/conversation-session/conversation-session-v4-composer-toolbar.test.ts",
        ),
    )
  );
}

async function loadComposerFitObserver() {
  const source = insideWorktree(path.join(__dirname, "qa-composer-fit-observer.ts"));
  auditWindowsReparsePoints([source]);
  const observerSourceSha256 = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  const { tsImport } = desktopRequire("tsx/esm/api");
  const observer = await tsImport(pathToFileURL(source).href, {
    parentURL: pathToFileURL(__filename).href,
    tsconfig: path.join(desktop, "tsconfig.e2e.json"),
  });
  return { observer, observerSourceSha256 };
}

async function beginComposerFitObservationBeforeEach() {
  if (!isComposerFitObservationTarget(this)) return;
  const { observer } = await loadComposerFitObserver();
  await observer.beginComposerFitObservation(this);
}

async function finishComposerFitObservationAfterEach() {
  if (!isComposerFitObservationTarget(this)) return;
  const paths = isolatedPaths();
  const { observer, observerSourceSha256 } = await loadComposerFitObserver();
  await observer.finishComposerFitObservation(this, {
    artifacts: paths.artifacts,
    observerSourceSha256,
    hookSourceSha256,
  });
}

function isGroupedTarget(test) {
  return (
    test?.title === "GRP04/05/06：组内首发、三视图菜单、置顶/归档和恢复保持成员" &&
    Boolean(
      test.file
        ?.replaceAll("\\", "/")
        .endsWith(
          "/packages/desktop/test/e2e/conversation-session/conversation-session-task-groups.test.ts",
        ),
    )
  );
}

async function prepareGroupedTargetBeforeEach() {
  if (process.env.QA_BOOTSTRAP_GROUPED_TARGET !== "1") return;
  if (process.env.ZCODE_E2E_RUN_ID !== "qa-menu-20261106-grp-pin-grouped")
    throw new Error("QA grouped hook refuses an unreviewed run");
  if (!isGroupedTarget(this.currentTest)) return;
  const paths = isolatedPaths();
  const workerId = (process.env.WDIO_WORKER_ID || String(process.pid)).replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const stem = insideWorktree(
    path.join(
      paths.artifacts,
      "qa-grouped-precondition-" + workerId + "-" + process.pid + "-" + Date.now(),
    ),
  );
  const capture = async (phase) => {
    const snapshot = await globalThis.browser.execute(() => ({
      groupedViewPresent: Boolean(document.querySelector('[data-testid="task-grouped-view"]')),
      groupAddCount: document.querySelectorAll('[data-testid="task-group-add"]').length,
      radioCount: document.querySelectorAll('[data-testid="sidebar-view-grouped"]').length,
      radioState:
        document
          .querySelector('[data-testid="sidebar-view-grouped"]')
          ?.getAttribute("data-state") ?? null,
      radioChecked:
        document
          .querySelector('[data-testid="sidebar-view-grouped"]')
          ?.getAttribute("aria-checked") ?? null,
    }));
    await fsp.writeFile(
      insideWorktree(stem + "-" + phase + ".json"),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          hookSourceSha256,
          phase,
          snapshot,
          evidenceKind: "real UI grouped precondition only; no product state injection",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    const target = insideWorktree(stem + "-" + phase + ".png");
    const reserved = await fsp.open(target, "wx");
    await reserved.close();
    await globalThis.browser.saveScreenshot(target);
  };
  await capture("before");
  const menu = globalThis.$('[data-testid="sidebar-view-menu"]');
  await menu.waitForClickable();
  await menu.click();
  const radio = globalThis.$('[data-testid="sidebar-view-grouped"]');
  await radio.waitForDisplayed();
  const radioCount = await globalThis.$$('[data-testid="sidebar-view-grouped"]');
  if (radioCount.length !== 1) throw new Error("QA grouped view menu is not unique");
  await radio.click();
  await radio.waitForExist({ reverse: true });
  await globalThis.$('[data-testid="task-grouped-view"]').waitForDisplayed();
  await globalThis.$('[data-testid="task-group-add"]').waitForClickable();
  await menu.click();
  await radio.waitForDisplayed();
  if (
    (await radio.getAttribute("data-state")) !== "checked" ||
    (await radio.getAttribute("aria-checked")) !== "true"
  ) {
    throw new Error("QA grouped preference did not converge to checked");
  }
  await capture("checked");
  await globalThis.browser.keys("Escape");
  await radio.waitForExist({ reverse: true });
  await globalThis.$('[data-testid="task-group-add"]').waitForClickable();
  await capture("after");
}

exports.mochaHooks = function qaRootHookPlugin() {
  // WDIO 9 的 Object.assign(mochaOpts, plugins) 会覆盖已有 rootHooks。
  // 从框架初始化前 browser stub 的 options 取得原函数，先运行原 bridge preflight。
  const original = globalThis.browser?.options?.mochaOpts?.rootHooks;
  const cast = (value) =>
    value === undefined ? [] : Array.isArray(value) ? value.slice() : [value];
  if (!original || cast(original.beforeAll).length === 0) {
    throw new Error("QA bootstrap refuses to replace or bypass existing WDIO renderer preflight");
  }
  return {
    beforeAll: [...cast(original.beforeAll), bootstrapProject],
    beforeEach: [
      ...cast(original.beforeEach),
      beginReloadObservationBeforeEach,
      beginComposerFitObservationBeforeEach,
      prepareGroupedTargetBeforeEach,
    ],
    afterAll: cast(original.afterAll),
    afterEach: [
      finishReloadObservationAfterEach,
      finishComposerFitObservationAfterEach,
      observeSpfv002AfterEach,
      ...cast(original.afterEach),
    ],
  };
};
