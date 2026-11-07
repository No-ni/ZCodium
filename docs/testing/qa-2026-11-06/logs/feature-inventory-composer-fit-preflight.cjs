"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const repository = path.resolve(__dirname, "../../../..");
const source = path.join(repository, "docs/testing/qa-2026-11-06/qa-composer-fit-observer.ts");
const runtime = path.join(repository, "docs/testing/qa-2026-11-06/runtime/qa-composer-fit-static");
const artifacts = path.join(runtime, "artifacts");
const evidencePath = path.join(__dirname, "feature-inventory-composer-fit-preflight.json");

async function safe(candidate) {
  const resolved = path.resolve(candidate);
  const rel = path.relative(repository, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("Static probe path outside worktree");
  for (let cursor = resolved; ; cursor = path.dirname(cursor)) {
    try {
      const item = await fs.lstat(cursor);
      if (
        item.isSymbolicLink() ||
        (await fs.realpath(cursor)).toLowerCase() !== cursor.toLowerCase()
      )
        throw new Error("Static probe reparse/redirected ancestor");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (cursor.toLowerCase() === repository.toLowerCase()) break;
  }
  return resolved;
}

(async () => {
  for (const candidate of [
    source,
    runtime,
    evidencePath,
    require.resolve("typescript"),
    require.resolve("tsx/esm/api"),
    require.resolve("oxlint/package.json"),
  ])
    await safe(candidate);
  for (const key of [
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "TSX_CACHE_DIR",
    "NODE_COMPILE_CACHE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]) {
    process.env[key] = path.join(runtime, key.toLowerCase());
    await fs.mkdir(await safe(process.env[key]), { recursive: true });
  }
  process.env.NODE_OPTIONS = "";
  process.env.ZCODE_E2E_ARTIFACT_DIR = artifacts;
  await fs.mkdir(await safe(artifacts), { recursive: true });
  const ts = require("typescript");
  const configPath = path.join(repository, "packages/desktop/tsconfig.e2e.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const options = {
    ...parsed.options,
    rootDir: repository,
    composite: false,
    incremental: false,
    noEmit: true,
  };
  delete options.tsBuildInfoFile;
  const program = ts.createProgram([source], options);
  const diagnostics = ts.getPreEmitDiagnostics(program).map((item) => ({
    code: item.code,
    file: item.file?.fileName ?? null,
    line:
      item.file && item.start !== undefined
        ? item.file.getLineAndCharacterOfPosition(item.start).line + 1
        : null,
    message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
  }));
  let forbiddenCalls = 0;
  globalThis.browser = {
    execute: () => {
      forbiddenCalls++;
      throw new Error("Static probe must not call browser");
    },
    takeScreenshot: () => {
      forbiddenCalls++;
      throw new Error("Static probe must not capture browser");
    },
  };
  const { tsImport } = require("tsx/esm/api");
  const observer = await tsImport(pathToFileURL(source).href, {
    parentURL: pathToFileURL(__filename).href,
    tsconfig: configPath,
  });
  const scripts = [observer.COMPOSER_FIT_BEGIN_SCRIPT, observer.COMPOSER_FIT_FINISH_SCRIPT];
  const rawScriptsParsed = scripts.every((script) => {
    new Function(script);
    return !/\b__name(?:\d+)?\b/u.test(script);
  });
  const actualFile = path.join(
    repository,
    "packages/desktop/test/e2e/conversation-session/conversation-session-v4-composer-toolbar.test.ts",
  );
  const actualTitle =
    "keeps the open model picker responsive when the composer shrinks and expands";
  const excluded = [
    {},
    {
      currentTest: {
        title: "completed task 的 picker 不跨 scope 自动弹到新 draft",
        file: actualFile,
      },
    },
    {
      currentTest: {
        title: actualTitle,
        file: path.join(repository, "docs/testing/wrong.test.ts"),
      },
    },
  ];
  const beforeFiles = await fs.readdir(artifacts);
  for (const context of excluded) {
    await observer.beginComposerFitObservation(context);
    await observer.finishComposerFitObservation(context, {});
  }
  const afterFiles = await fs.readdir(artifacts);
  const lintBinary = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
  let lint;
  try {
    const result = await execFileAsync(process.execPath, [lintBinary, source], {
      cwd: repository,
      env: process.env,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    lint = { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    lint = {
      exitCode: Number(error.code) || 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
  const evidence = {
    capturedAt: new Date().toISOString(),
    evidenceKind:
      "Target-only TypeScript noEmit, lint, raw JS parse and TSX excluded-case guards; no UI/build/hook integration",
    node: process.version,
    sourceSha256: createHash("sha256")
      .update(await fs.readFile(source))
      .digest("hex"),
    diagnostics,
    lint,
    rawScriptsParsed,
    scriptLengths: scripts.map((script) => script.length),
    excludedCases: excluded.length,
    excludedHookCalls: excluded.length * 2,
    forbiddenCalls,
    excludedCasesCreatedNoArtifacts: JSON.stringify(beforeFiles) === JSON.stringify(afterFiles),
    runtime,
    artifacts,
    allPassed:
      diagnostics.length === 0 &&
      lint.exitCode === 0 &&
      rawScriptsParsed &&
      forbiddenCalls === 0 &&
      JSON.stringify(beforeFiles) === JSON.stringify(afterFiles),
  };
  await fs.writeFile(await safe(evidencePath), JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({
      evidencePath,
      allPassed: evidence.allPassed,
      diagnostics: diagnostics.length,
      lintExitCode: lint.exitCode,
      rawScriptsParsed,
      forbiddenCalls,
    }) + "\n",
  );
  if (!evidence.allPassed) process.exitCode = 1;
})().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
