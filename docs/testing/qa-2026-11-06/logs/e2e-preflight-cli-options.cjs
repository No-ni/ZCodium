"use strict";
// 只求值已安装 WDIO 的 parser/coerce 定义，不实例化 Launcher 或运行应用。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const repository = path.resolve(__dirname, "../../../..");
const cliPath = path.join(repository, "node_modules/@wdio/cli/build/index.js");
const source = fs.readFileSync(cliPath, "utf8");
const cliRequire = createRequire(path.join(repository, "node_modules/@wdio/cli/package.json"));
const yargs = cliRequire("yargs/yargs");
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf("var cucumberTypes ="), source.indexOf("var NodeVersion =")), context);
const optionsStart = source.indexOf("var cmdArgs = {");
const optionsEnd = source.indexOf("var builder = ", optionsStart);
vm.runInContext(source.slice(optionsStart, optionsEnd), context);
const bootstrap = "../../docs/testing/qa-2026-11-06/qa-project-bootstrap.cjs";
const cases = [
  { name: "previous-with-separator", args: ["run", "wdio.conf.ts", "--", "--spec=test/e2e/plus-menu.test.ts", "--mochaOpts.require=" + bootstrap] },
  { name: "correct-without-separator", args: ["run", "wdio.conf.ts", "--spec=test/e2e/plus-menu.test.ts", "--mochaOpts.require=" + bootstrap] },
];
const results = cases.map(({ name, args }) => {
  const parsed = yargs(args).exitProcess(false).options(context.cmdArgs).parse();
  return { name, args, positional: parsed._, spec: parsed.spec ?? null, mochaOpts: parsed.mochaOpts ?? null, loaderWouldHandleRequire: Array.isArray(parsed.mochaOpts?.require) };
});
if (results[0].loaderWouldHandleRequire || !results[1].loaderWouldHandleRequire || results[1].mochaOpts.require[0] !== bootstrap) throw new Error("WDIO parser result did not match expected separator behavior");
const evidence = { evidenceKind: "installed @wdio/cli parser only; no UI/app/Launcher execution", source: cliPath, capturedAt: new Date().toISOString(), results };
fs.writeFileSync(path.join(__dirname, "e2e-preflight-cli-options.json"), JSON.stringify(evidence, null, 2) + "\n");
process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
