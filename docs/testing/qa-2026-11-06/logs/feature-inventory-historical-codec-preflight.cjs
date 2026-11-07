"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { isDeepStrictEqual } = require("node:util");
const ts = require("typescript");
const root = path.resolve(__dirname, "../../../..");
const source = path.join(
  root,
  "docs/testing/qa-2026-11-06/manual-review/pending/qa-historical-trajectory-20261106.test.ts",
);
const guard = path.join(root, "docs/testing/qa-2026-11-06/qa-reparse-children.ps1");
const runtime = path.join(
  root,
  `docs/testing/qa-2026-11-06/runtime/qa-historical-codec-static-${process.pid}-${Date.now()}`,
);
const output = path.join(
  __dirname,
  `feature-inventory-historical-codec-${process.pid}-${Date.now()}.json`,
);
function safe(target) {
  const rel = path.relative(root, target);
  if (!rel || path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`))
    throw new Error("HIST codec outside worktree");
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    if (
      fs.existsSync(cursor) &&
      (fs.lstatSync(cursor).isSymbolicLink() ||
        fs.realpathSync.native(cursor).toLowerCase() !== cursor.toLowerCase())
    )
      throw new Error("HIST codec redirected ancestor");
    if (cursor.toLowerCase() === root.toLowerCase()) break;
  }
  return target;
}
for (const target of [source, guard, runtime, output]) safe(target);
const auditScript =
  fs.readFileSync(guard, "utf8") +
  "\n$ErrorActionPreference='Stop';$target=$env:HIST_CODEC_TARGET;$cursor=[IO.Path]::GetFullPath($target);while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'HIST codec reparse ancestor'}};$cursor=[IO.Path]::GetDirectoryName($cursor)};if(Test-Path -LiteralPath $target){$queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($target);while($queue.Count){foreach($item in Get-QaAuditChildren $queue.Dequeue()){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'HIST codec reparse descendant'};if($item.PSIsContainer){$queue.Enqueue($item.FullName)}}}}";
execFileSync(
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  ["-NoProfile", "-NonInteractive", "-Command", auditScript],
  {
    env: { ...process.env, HIST_CODEC_TARGET: runtime, QA_REPARSE_WORKTREE: root },
    windowsHide: true,
    stdio: "pipe",
    timeout: 30_000,
  },
);
fs.mkdirSync(runtime);
for (const key of [
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
]) {
  const target = safe(
    path.join(
      runtime,
      ["HOME", "USERPROFILE", "ZCODE_E2E_HOME_DIR"].includes(key) ? "home" : key.toLowerCase(),
    ),
  );
  process.env[key] = target;
  if (key === "npm_config_userconfig") fs.writeFileSync(target, "", { flag: "wx" });
  else fs.mkdirSync(target, { recursive: true });
}
process.env.NODE_OPTIONS = "";
process.env.E2E_PROVIDER_HTTP_MODE = "replay";
process.env.ZCODE_E2E_MANUAL_REVIEW = "1";
const text = fs.readFileSync(source, "utf8");
const ast = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const fn = ast.statements.find(
  (item) => ts.isFunctionDeclaration(item) && item.name?.text === "importedTask",
);
if (!fn?.body) throw new Error("HIST actual importedTask missing");
const preamble = [];
for (const statement of fn.body.statements) {
  if (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((item) => item.name.getText(ast) === "bytes")
  )
    break;
  preamble.push(statement.getText(ast));
}
if (!preamble.some((item) => item.includes("const input:")))
  throw new Error("HIST actual archive input missing");
const compiled = ts.transpileModule(
  `function extractedInput(){${preamble.join("\n")}\nreturn input;} module.exports=extractedInput;`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const context = {
  module: { exports: null },
  BODY: "QA_HIST_IMPORTED_USER",
  process: { pid: 0 },
  Date: { now: () => 0 },
};
vm.runInNewContext(compiled, context);
const original = JSON.parse(JSON.stringify(context.module.exports()));
const corrected = JSON.parse(JSON.stringify(original));
corrected.selectedProductTurnIds = ["share-product-turn-1"];
corrected.rows.forEach((row, index) => {
  row.turnId = "share-turn-1";
  row.productTurnId = "share-product-turn-1";
  row.entityId = `share-entity-${index + 1}`;
});
const evidence = {
  capturedAt: new Date().toISOString(),
  evidenceKind:
    "Actual public encode/decode in-memory synthetic manifest probe; no UI/Host/provider/build/task/history",
  source: { file: source, sha256: createHash("sha256").update(text).digest("hex") },
  runtime,
  originalInput: original,
  correctedInput: corrected,
};
(async () => {
  const { tsImport } = require("tsx/esm/api");
  const codec = await tsImport(
    pathToFileURL(safe(path.join(root, "packages/services/src/node.ts"))).href,
    {
      parentURL: pathToFileURL(__filename).href,
      tsconfig: path.join(root, "packages/desktop/tsconfig.e2e.json"),
    },
  );
  const normalize = (module) => (module.encodeConversationArchive ? module : module.default);
  const { encodeConversationArchive, decodeConversationArchive } = normalize(codec);
  try {
    const originalBytes = await encodeConversationArchive(original);
    const originalDecoded = await decodeConversationArchive(originalBytes);
    evidence.original = {
      rejected: false,
      rowsEqual: isDeepStrictEqual(originalDecoded.content.rows, original.rows),
      selectedIdsEqual: isDeepStrictEqual(
        originalDecoded.content.selectedProductTurnIds,
        original.selectedProductTurnIds,
      ),
      byteLength: originalBytes.length,
    };
  } catch (error) {
    evidence.original = { rejected: true, code: error.code, message: error.message };
  }
  const bytes = await encodeConversationArchive(corrected);
  const decoded = await decodeConversationArchive(bytes);
  evidence.corrected = {
    byteLength: bytes.length,
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    decodedContent: decoded.content,
    artifacts: decoded.artifacts.size,
    rowsEqual: isDeepStrictEqual(decoded.content.rows, corrected.rows),
    selectedIdsEqual: isDeepStrictEqual(
      decoded.content.selectedProductTurnIds,
      corrected.selectedProductTurnIds,
    ),
  };
  evidence.mode = process.argv.includes("--current")
    ? "current-source-roundtrip"
    : "original-rejection-and-minimal-correction";
  evidence.accepted =
    (evidence.mode === "current-source-roundtrip"
      ? evidence.original.rejected === false &&
        evidence.original.rowsEqual &&
        evidence.original.selectedIdsEqual
      : evidence.original.rejected === true && evidence.original.code === "invalid_archive") &&
    evidence.corrected.rowsEqual &&
    evidence.corrected.selectedIdsEqual &&
    decoded.artifacts.size === 0;
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(
    JSON.stringify({
      output,
      accepted: evidence.accepted,
      source: evidence.source,
      original: evidence.original,
      corrected: {
        byteLength: bytes.length,
        rowsEqual: evidence.corrected.rowsEqual,
        selectedIdsEqual: evidence.corrected.selectedIdsEqual,
      },
    }) + "\n",
  );
  if (!evidence.accepted) process.exitCode = 1;
})().catch((error) => {
  evidence.error = error.stack;
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
