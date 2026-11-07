"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../../../..");
const panelRetry = process.argv.includes("--panel-retry");
const archiveActions = process.argv.includes("--archive-actions");
const finalCountArgument = process.argv.find((item) => item.startsWith("--final-local-count="));
const finalLocalCount = finalCountArgument ? Number(finalCountArgument.split("=")[1]) : 0;
const shortPreviewReviewed = process.argv.includes("--short-preview-reviewed");
const titleArgument = process.argv.find((item) => item.startsWith("--title-fixture="));
const titleFixture = titleArgument
  ? path.resolve(root, titleArgument.slice("--title-fixture=".length))
  : null;
if (panelRetry && finalLocalCount !== 7)
  throw new Error("Panel retry requires actual reviewed final-local count 7");
if (!panelRetry && (titleFixture || finalCountArgument || shortPreviewReviewed))
  throw new Error("Panel-only arguments cannot alter historical batch");
const runtime = path.join(
  root,
  "docs/testing/qa-2026-11-06/runtime",
  panelRetry ? "qa-local-panel-retry-static" : "qa-local-supplement-static",
);
const guard = path.join(root, "docs/testing/qa-2026-11-06/qa-reparse-children.ps1");
const includeResidual = process.argv.includes("--residual-reviewed");
const includeShort = process.argv.includes("--short-reviewed");
const archiveOnly = process.argv.includes("--archive-list-only");
if (archiveOnly && (includeResidual || includeShort))
  throw new Error("Archive must remain an independent finite fixture batch");
if (panelRetry && (archiveOnly || includeResidual || includeShort))
  throw new Error("Panel retry is independent; no archive/old whole-menu modes");
if (archiveActions && (panelRetry || archiveOnly || includeResidual || includeShort))
  throw new Error("Archive actions must remain its independent two-case batch");
const specNames = archiveActions ? ["qa-archive-actions-20261106.test.ts"] : panelRetry
  ? [
      "qa-runtime-copy-find-20261106.test.ts",
      "qa-historical-trajectory-20261106.test.ts",
      "qa-residual-local-menus-20261106.test.ts",
      "qa-final-local-gaps-20261106.test.ts",
    ]
  : [
      "qa-local-menu-actions-20261106.test.ts",
      "qa-runtime-copy-find-20261106.test.ts",
      "qa-historical-trajectory-20261106.test.ts",
    ];
if (includeResidual) specNames.push("qa-residual-local-menus-20261106.test.ts");
if (includeShort) specNames.push("qa-short-local-menus-20261106.test.ts");
if (panelRetry && shortPreviewReviewed) specNames.push("qa-short-local-menus-20261106.test.ts");
const sources = archiveOnly
  ? [
      path.join(
        root,
        "packages/desktop/test/e2e/conversation-session/conversation-session-archive-management.test.ts",
      ),
    ]
  : specNames.map((name) =>
      path.join(root, "docs/testing/qa-2026-11-06/manual-review/pending", name),
    );
const panelHelpers = panelRetry ? ["qa-menu-dom.ts", "qa-preview-dom.ts", "qa-local-rpc-probe.ts"].map((name) => path.join(root, "docs/testing/qa-2026-11-06", name)) : [];
const fixtures = [
  "common.json",
  archiveOnly || archiveActions
    ? "conversation-session/conversation-session-archive-management.json"
    : "conversation-session/conversation-session-chat-find-refocus.json",
].map((name) => path.join(root, "packages/desktop/test/e2e/fixtures/upstream", name));
if (titleFixture) {
  if (
    path.extname(titleFixture) !== ".json" ||
    path.basename(titleFixture) === "conversation-session-archive-management.json" ||
    fixtures.includes(titleFixture)
  )
    throw new Error(
      "Panel title fixture must be distinct reviewed local JSON; archive stays independent",
    );
  fixtures.push(titleFixture);
}
if (panelRetry) {
  const approvedTitle = path.join(root, "docs/testing/qa-2026-11-06/fixtures/qa-runtime-copy-find-title.json");
  if (!shortPreviewReviewed || titleFixture !== approvedTitle)
    throw new Error("Final panel retry requires reviewed SLM15 and exact SETUP title fixture");
  const expected = new Map([
    ["qa-runtime-copy-find-20261106.test.ts", "e5066f5ccf1fe6686ad4c69903fb53d654ebe4c2c00ccdfec9adef7a4461d50e"],
    ["qa-historical-trajectory-20261106.test.ts", "44857be6e3dbfe5e9c9afc4372dd67ceb43046bc496ce4d94e5d7ab89037ba8c"],
    ["qa-residual-local-menus-20261106.test.ts", "eaebe0c7aaf09d13946e99827db1960a1808ac1dacfbca496dcf71c75100c152"],
    ["qa-final-local-gaps-20261106.test.ts", "673cb61cee52884b4028003aac2daadfd30198393c0b9a97dd1e16ec4f46b933"],
    ["qa-short-local-menus-20261106.test.ts", "5cff511dc4b82153fb71ff9d6e2bac8c229ec18cef4b171bac5bcb39174ad4af"],
    ["qa-menu-dom.ts", "dba3eca2867cccac260b285dd7e82463ce021df7d879c32dc692852d7b74c493"],
    ["qa-preview-dom.ts", "3646eaec8b75953d7944c864fde82d65770bef502b3cb049a1e366183a99d01d"],
    ["qa-local-rpc-probe.ts", "d75cfa0bd781b866ffd3d19ae3152995c1b724a7f6944817df2257dc7a53416a"],
    ["qa-runtime-copy-find-title.json", "742c1eb7c965f428eb95709ec7ec8e3619bc2dc37b2be5b00ea6390c62c75631"],
  ]);
  for (const file of [...sources, ...panelHelpers, titleFixture]) {
    if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== expected.get(path.basename(file)))
      throw new Error("Final panel retry source changed after reviewed READY: " + path.basename(file));
  }
}
const output = path.join(
  __dirname,
  archiveActions
    ? "feature-inventory-archive-actions-preflight.json"
    : archiveOnly
    ? "feature-inventory-archive-list-retry-preflight.json"
    : panelRetry
      ? "feature-inventory-local-panel-retry-preflight.json"
      : "feature-inventory-local-supplement-preflight.json",
);
const grep = archiveActions ? "(?:^| )QAR0[12]:" : archiveOnly
  ? "(?:^| )ARM(?:01/05/06|02|03)："
  : panelRetry
    ? "(?:^| )(?:HIST0[12]:|RFC0[12]:|RMC03:|FLG0[1-" + finalLocalCount + "]:|RLM-0[56]:" + (shortPreviewReviewed ? "|SLM15:" : "") + ")"
    : "(?:^| )(?:QLA(?:05|08):|RFC0[12]:|RMC03:|HIST0[12]:" +
      (includeResidual ? "|RLM-?(?:0[4-9]|1[0-3]):" : "") +
      (includeShort ? "|SLM(?:06|08|09|13|15):" : "") +
      ")";
function assertPath(candidate) {
  const target = path.resolve(candidate);
  const rel = path.relative(root, target);
  if (!rel || path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`))
    throw new Error("Supplement static outside worktree");
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    if (
      fs.existsSync(cursor) &&
      (fs.lstatSync(cursor).isSymbolicLink() ||
        fs.realpathSync.native(cursor).toLowerCase() !== cursor.toLowerCase())
    )
      throw new Error("Supplement static reparse/redirected path");
    if (cursor.toLowerCase() === root.toLowerCase()) break;
  }
  return target;
}
for (const target of [runtime, guard, output, ...sources, ...panelHelpers, ...fixtures]) assertPath(target);
const childAudit =
  fs.readFileSync(guard, "utf8") +
  "\n$ErrorActionPreference='Stop';$target=$env:SUPPLEMENT_STATIC_TARGET;if(Test-Path -LiteralPath $target){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Supplement static reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}";
execFileSync(
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  ["-NoProfile", "-NonInteractive", "-Command", childAudit],
  {
    env: { ...process.env, SUPPLEMENT_STATIC_TARGET: runtime, QA_REPARSE_WORKTREE: root },
    windowsHide: true,
    stdio: "pipe",
    timeout: 30_000,
  },
);
const home = path.join(runtime, ".e2e-home-static");
for (const name of [
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "COREPACK_HOME",
  "PNPM_HOME",
  "npm_config_cache",
  "npm_config_store_dir",
  "npm_config_userconfig",
  "TSX_CACHE_DIR",
  "NODE_COMPILE_CACHE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "ZCODE_E2E_HOME_DIR",
  "ZCODE_E2E_ARTIFACT_DIR",
  "ZCODE_E2E_NETWORK_CAPTURE_DIR",
  "E2E_PROVIDER_CAPTURE_PATH",
]) {
  const value = ["HOME", "USERPROFILE", "ZCODE_E2E_HOME_DIR"].includes(name)
    ? home
    : path.join(runtime, name.toLowerCase());
  assertPath(value);
  process.env[name] = value;
  if (name === "npm_config_userconfig" || name === "E2E_PROVIDER_CAPTURE_PATH") {
    fs.mkdirSync(path.dirname(value), { recursive: true });
    if (name === "npm_config_userconfig") fs.writeFileSync(value, "");
  } else fs.mkdirSync(value, { recursive: true });
}
process.env.NODE_OPTIONS = "";
process.env.E2E_PROVIDER_HTTP_MODE = "replay";
process.env.E2E_PROVIDER_CAPTURE_MODE = "replay";
process.env.E2E_PROVIDER_API_KEY = "e2e-fixture-key";
process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH = fixtures.join(",");
process.env.ZCODE_E2E_MANUAL_REVIEW = "1";
const ts = require("typescript");
const configPath = path.join(root, "docs/testing/qa-2026-11-06/tsconfig.qa.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
const options = {
  ...parsed.options,
  rootDir: root,
  composite: false,
  incremental: false,
  noEmit: true,
};
delete options.tsBuildInfoFile;
const diagnostics = ts
  .getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, options))
  .map((item) => ({
    file: item.file?.fileName ?? null,
    code: item.code,
    message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
  }));
const registered = [];
const hooks = [];
let currentFile = "";
const suiteStack = [];
globalThis.describe = (title, callback) => {
  suiteStack.push(title);
  try {
    callback();
  } finally {
    suiteStack.pop();
  }
};
globalThis.it = (title) =>
  registered.push({
    file: currentFile,
    title,
    suites: [...suiteStack],
    fullTitle: [...suiteStack, title].join(" "),
  });
for (const kind of ["before", "after", "beforeEach", "afterEach"])
  globalThis[kind] = () => hooks.push({ file: currentFile, kind });
globalThis.browser = new Proxy(
  {},
  {
    get() {
      throw new Error("Supplement registration forbids all UI access");
    },
  },
);
const evidence = {
  capturedAt: new Date().toISOString(),
  evidenceKind:
    "NoEmit and real registration/filter only; no UI/hooks/Host/Provider/build/test task/history writes",
  includeResidual,
  includeShort,
  archiveOnly,
  archiveActions,
  panelRetry,
  finalLocalCount,
  shortPreviewReviewed,
  titleFixture,
  grep,
  sources: [...sources, ...panelHelpers, guard].map((file) => ({
    file,
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  })),
  fixtures: fixtures.map((file) => ({
    file,
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    fixtures: JSON.parse(fs.readFileSync(file, "utf8")).fixtures.map((item) => ({
      id: item.id,
      metadata: item.metadata,
    })),
  })),
  diagnostics,
  registered,
  hooks,
};
(async () => {
  const { tsImport } = require("tsx/esm/api");
  for (const file of sources) {
    currentFile = file;
    await tsImport(pathToFileURL(file).href, {
      parentURL: pathToFileURL(__filename).href,
      tsconfig: path.join(root, "packages/desktop/tsconfig.e2e.json"),
    });
  }
  const filter = new RegExp(grep, "u");
  evidence.grepTarget = "Mocha describe stack + it.title fullTitle";
  evidence.selected = registered.filter((item) => filter.test(item.fullTitle));
  evidence.excluded = registered.filter((item) => !filter.test(item.fullTitle));
  evidence.oldAnchoredTitleOnlyCount = registered.filter((item) =>
    new RegExp(grep.replace("(?:^| )", "^"), "u").test(item.title),
  ).length;
  evidence.oldAnchoredFullTitleCount = registered.filter((item) =>
    new RegExp(grep.replace("(?:^| )", "^"), "u").test(item.fullTitle),
  ).length;
  evidence.count = evidence.selected.length;
  evidence.accepted =
    diagnostics.length === 0 &&
    evidence.count ===
      (archiveActions ? 2 : archiveOnly
        ? 3
        : panelRetry
          ? 7 + finalLocalCount + (shortPreviewReviewed ? 1 : 0)
          : 7 + (includeResidual ? 10 : 0) + (includeShort ? 5 : 0)) &&
    new Set(evidence.selected.map((item) => item.title)).size === evidence.count;
  if (panelRetry) {
    const expectedPerSource = [3, 2, 2, finalLocalCount];
    if (shortPreviewReviewed) expectedPerSource.push(1);
    evidence.sourceSelectedCounts = sources.map((file, index) => ({
      file,
      expected: expectedPerSource[index],
      actual: evidence.selected.filter((item) => item.file === file).length,
    }));
    evidence.accepted &&= evidence.sourceSelectedCounts.every(
      (item) => item.expected === item.actual,
    );
    if (evidence.accepted) {
      const params = {
        RunId: "qa-menu-20261106-local-supplement-retry",
        Specs: sources.map((file) =>
          path.relative(path.join(root, "packages/desktop"), file).split(path.sep).join("/"),
        ),
        Grep: grep,
        ReplayFixtures: fixtures
          .map((file) =>
            path.relative(path.join(root, "packages/desktop"), file).split(path.sep).join("/"),
          )
          .join(","),
        Bootstrap: true,
        OpenSidePane: false,
        SafeTerminal: false,
        SafeGit: true,
        selected: evidence.count,
        sourceEvidence: output,
      };
      const paramsPath = path.join(
        __dirname,
        "feature-inventory-local-panel-retry-parameters.json",
      );
      assertPath(paramsPath);
      fs.writeFileSync(paramsPath, JSON.stringify(params, null, 2) + "\n");
      evidence.parameters = paramsPath;
    }
  }
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({
      output,
      accepted: evidence.accepted,
      diagnostics: diagnostics.length,
      specs: sources.length,
      selected: evidence.selected,
      excluded: evidence.excluded.length,
      grep,
    }) + "\n",
  );
  if (!evidence.accepted) process.exitCode = 1;
})().catch((error) => {
  evidence.importError = error.stack;
  evidence.accepted = false;
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
