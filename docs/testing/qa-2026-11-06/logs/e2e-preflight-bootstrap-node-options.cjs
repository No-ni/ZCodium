"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const hook = path.resolve(__dirname, "../qa-project-bootstrap.cjs");
const context = { require, __dirname: path.dirname(hook), __filename: hook, process, exports: {} };
vm.runInNewContext(fs.readFileSync(hook, "utf8") + "\nglobalThis.validate = validateWdioNodeOptions;", context, { filename: hook });
const loader = pathToFileURL(require.resolve("tsx")).href;
const cases = [
  ["empty", "", true],
  ["installed-cli", " --import " + loader, true],
  ["installed-local-runner-duplicate", " --import " + loader + " --import " + loader, true],
  ["installed-with-source-maps", " --import " + loader + " --enable-source-maps", true],
  ["reject-foreign-loader", "--import file:///C:/outside/loader.mjs", false],
  ["reject-arbitrary-require", "--import " + loader + " --require=evil.cjs", false],
  ["reject-unexpected-node-option", "--import " + loader + " --inspect=9229", false],
  ["reject-triple-injection", "--import " + loader + " --import " + loader + " --import " + loader, false],
];
const results = cases.map(([name, options, expected]) => {
  let accepted = false;
  let result;
  let error;
  try { result = context.validate(options); accepted = true; } catch (failure) { error = failure.message; }
  if (accepted !== expected) throw new Error("Unexpected acceptance: " + name);
  return { name, accepted, result, error };
});
const evidence = { evidenceKind: "pure option grammar plus read-only loader/reparse audit; no UI/hooks executed", capturedAt: new Date().toISOString(), sources: ["node_modules/@wdio/cli/build/index.js:922-925", "node_modules/@wdio/local-runner/build/index.js:262-276"], results };
fs.writeFileSync(path.join(__dirname, "e2e-preflight-bootstrap-node-options.json"), JSON.stringify(evidence, null, 2) + "\n");
process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
