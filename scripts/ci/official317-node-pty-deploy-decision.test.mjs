import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function fixture(available) {
  const path = "packages/server/src/remote/remoteAssetDeployDecision.ts";
  const text = await readFile(new URL("../../" + path, import.meta.url), "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const names = new Set([
    "deployNodePtyPrebuilds",
    "shouldDeployVersionedComponent",
    "normalizeDeployExpectedVersion",
    "logDeployRequired",
  ]);
  const source = file.statements
    .filter((node) => names.has(node.name?.text))
    .map((node) => node.getText(file).replace(/^export\s+/, ""))
    .join("\n");
  const code = ts.transpileModule(source + "\nreturn deployNodePtyPrebuilds;", {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const installs = [],
    metadata = [];
  class Installer {
    mode = "bundled-upload";
    async tryResolveLocalPath() {
      return available ? "fixture-local-prebuild" : null;
    }
    async installFile(value) {
      installs.push(value);
    }
  }
  const deploy = new Function(
    "LocalUploadAssetInstaller",
    "REMOTE_NODE_PTY_PATH",
    "REMOTE_NODE_PTY_SPAWN_HELPER_PATH",
    "readRemoteAssetComponentMeta",
    "writeRemoteAssetComponentMeta",
    code,
  )(
    Installer,
    "fixture/pty.node",
    "fixture/spawn-helper",
    async () => null,
    async (_backend, value) => metadata.push(value),
  );
  await deploy(
    { exists: async () => false },
    { platform: "linux", arch: "x64" },
    {
      platformArch: "linux-x64",
      onlyIfMissing: true,
      installer: new Installer(),
      expectedVersion: "fixture-version",
    },
    { log() {}, logWarn() {} },
  );
  return { installs, metadata };
}

test("the inherited installer commits an available prebuild once", async () => {
  const result = await fixture(true);
  assert.equal(result.installs.length, 1);
  assert.equal(result.metadata.length, 1);
});
test("a missing local prebuild cannot start upload or claim a committed component", async () => {
  const result = await fixture(false);
  assert.deepEqual(result.installs, []);
  assert.deepEqual(result.metadata, []);
});
