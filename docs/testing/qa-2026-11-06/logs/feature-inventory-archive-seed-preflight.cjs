"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../../../..");
const source = path.join(root, "docs/testing/qa-2026-11-06/manual-review/pending/qa-archive-actions-20261106.test.ts");
const hostSchema = path.join(root, "packages/services/src/project-storage/schema.baseline.sql");
const cliSchema = path.join(root, "apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql");
const output = path.join(__dirname, "feature-inventory-archive-seed-preflight.json");
for (const target of [source, hostSchema, cliSchema, output]) for (let cursor = target; ; cursor = path.dirname(cursor)) {
  if (fs.existsSync(cursor) && (fs.lstatSync(cursor).isSymbolicLink() || fs.realpathSync.native(cursor).toLowerCase() !== cursor.toLowerCase())) throw new Error("QAR seed static reparse path");
  if (cursor.toLowerCase() === root.toLowerCase()) break;
}
const sourceText = fs.readFileSync(source, "utf8");
const ast = ts.createSourceFile(source, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functionNode = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "seedOwnArchivedTasks");
if (!functionNode) throw new Error("QAR seed source missing");
const constantNames = new Set(["PREFIX", "PROJECT", "IDS", "NAMES"]);
const constants = ast.statements.filter((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => constantNames.has(item.name.getText(ast)))).map((node) => node.getText(ast));
if (constants.length !== 4) throw new Error("QAR source fixture constants mismatch");
const scripts = [];
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "browser.execute") {
    const argument = node.arguments[0];
    if (!argument || !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) throw new Error("QAR requires raw renderer script");
    new vm.Script("(function(){\n" + argument.text + "\n})");
    scripts.push({ pos: ast.getLineAndCharacterOfPosition(argument.getStart(ast)).line + 1, parse: true, externalNameHelper: /__name\d*/u.test(argument.text) });
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const host = new DatabaseSync(":memory:");
const cli = new DatabaseSync(":memory:");
const probes = [];
let closedBySource = 0;
try {
  host.exec(fs.readFileSync(hostSchema, "utf8"));
  host.prepare("INSERT INTO hosts(host_id,kind) VALUES('local','local')").run();
  cli.exec(fs.readFileSync(cliSchema, "utf8"));
  const construct = function (key) {
    const db = key === "host" ? host : key === "cli" ? cli : null;
    if (!db) throw new Error("QAR static database key outside memory");
    return { prepare(sql) { return db.prepare(sql); }, close() { closedBySource++; } };
  };
  const js = ts.transpileModule(constants.join("\n") + "\n" + functionNode.getText(ast) + "\nthis.seed=seedOwnArchivedTasks;this.readIds=()=>IDS;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { DatabaseSync: construct, hostDatabase: "host", cliDatabase: "cli", DEFAULT_WORKSPACE: path.join(root, "docs/testing/qa-2026-11-06/runtime/qa-archive-static-memory-only/ZCodeProject"), process: { pid: process.pid } };
  vm.createContext(context);
  vm.runInContext(js, context);
  context.seed();
  const ids = context.readIds();
  const states = host.prepare("SELECT task_id,archived,cli_deleted,project_id,meta_json FROM tasks ORDER BY task_id").all();
  const cliRows = cli.prepare("SELECT id,title_source,time_deleted FROM session ORDER BY id").all();
  probes.push({ name: "actual source seed on both current baseline schemas", passed: states.length === 3 && cliRows.length === 3 && states.every((item) => ids.includes(item.task_id) && item.archived === 1 && item.cli_deleted === 0 && JSON.parse(item.meta_json).taskId === item.task_id) && cliRows.every((item) => item.title_source === "custom" && item.time_deleted === null), hostRows: states.map(({ meta_json, ...item }) => ({ ...item, metaTaskId: JSON.parse(meta_json).taskId })), cliRows });
  let rejected = false;
  try { context.seed(); } catch (error) { rejected = error.message === "QAR refuses existing task identity"; }
  probes.push({ name: "second seed refuses duplicate IDs before mutation", passed: rejected && host.prepare("SELECT COUNT(*) count FROM tasks").get().count === 3 && cli.prepare("SELECT COUNT(*) count FROM session").get().count === 3 });
  probes.push({ name: "source finally closes both handles on success and refusal", passed: closedBySource === 4, calls: closedBySource });
  const evidence = { capturedAt: new Date().toISOString(), evidenceKind: "actual source seed executed only in SQLite :memory: using current host/CLI baseline DDL; no UI/Host/process/replay/filesystem task data", sources: [source, hostSchema, cliSchema].map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") })), scripts, probes, accepted: probes.every((item) => item.passed) && scripts.length === 2 && scripts.every((item) => item.parse && !item.externalNameHelper) };
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ output, accepted: evidence.accepted, probes: probes.length, rawScripts: scripts.length }) + "\n");
  if (!evidence.accepted) process.exitCode = 1;
} finally {
  host.close();
  cli.close();
}
