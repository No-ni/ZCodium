import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT);
const sandbox = await createProjectTestSandbox("attachment-owner");
const output = await build({
  entryPoints: [join(projectRoot, "packages/ui/src/store/composerAttachmentUploadStore.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  packages: "external",
  alias: { "@": join(projectRoot, "packages/ui/src") },
});
const bundle = await assertProjectPath(join(sandbox.root, "store.mjs"));
await writeFile(bundle, output.outputFiles[0].contents, { flag: "wx" });
const store = await import(pathToFileURL(bundle).href);
const text = await readFile(
  join(projectRoot, "packages/ui/src/v4/composer/useComposerAttachments.ts"),
  "utf8",
);
const ast = ts.createSourceFile(
  "attachments.tsx",
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const declarations = new Map();
function visit(n) {
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) declarations.set(n.name.text, n);
  ts.forEachChild(n, visit);
}
visit(ast);
function callback(name, ports) {
  const source = declarations.get(name).initializer.arguments[0].getText(ast);
  const { outputText } = ts.transpileModule(`const callback=${source};`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return new Function(...Object.keys(ports), outputText + "\nreturn callback;")(
    ...Object.values(ports),
  );
}
const logger = { warn() {} };
function owner() {
  const scopeKey = "fixture\0draft";
  const commitScope = callback("commitScope", {
    updateComposerAttachmentScope: store.updateComposerAttachmentScope,
  });
  const updateItem = callback("updateItem", { commitScope });
  const ports = {
    scopeKey,
    updateItem,
    readComposerAttachmentScope: store.readComposerAttachmentScope,
    logger,
  };
  return {
    scopeKey,
    reserve: callback("reserveSentAttachments", ports),
    release: callback("releaseSentAttachmentReservations", ports),
    adopt: callback("adoptSentAttachments", ports),
  };
}

test("partial adopt retains the actual scope and retries only its remaining operation", async () => {
  store.useComposerAttachmentUploadStore.setState({ scopes: {}, handoffs: {} });
  const h = owner();
  const calls = [];
  let fail = true;
  const transfer = {
    async reserveForSubmission(id) {
      calls.push("reserve:" + id);
    },
    async releaseSubmissionReservation(id) {
      calls.push("release:" + id);
    },
    async adopt(id) {
      calls.push("adopt:" + id);
      if (id === "two" && fail) throw Error("disconnected");
    },
  };
  store.updateComposerAttachmentScope(h.scopeKey, () =>
    ["one", "two"].map((id) => ({
      id,
      operationId: id,
      referenceOwnership: "composer",
      staged: true,
      adopted: false,
      submissionTransfer: transfer,
      uploadStatus: "ready",
    })),
  );
  await h.reserve(["one", "two"]);
  await assert.rejects(h.adopt(["one", "two"]), /disconnected/);
  const rows = store.readComposerAttachmentScope(h.scopeKey);
  assert.equal(rows[0].adopted, true);
  assert.equal(rows[1].adopted, false);
  assert.equal(rows[1].handoffPending, true);
  const token = Symbol("original");
  const retry = () => h.adopt(["one", "two"]);
  store.setComposerAttachmentHandoff(
    h.scopeKey,
    { owner: token, displayScopeKey: "fixture\0session", phase: "failed", retry },
    token,
  );
  const select = callback("submissionHandoff", {
    scopeKey: "fixture\0session",
    workspacePath: "fixture",
    workspaceIdentity: undefined,
    options: { submissionOwner: token },
  });
  const reMounted = select(store.useComposerAttachmentUploadStore.getState());
  assert.equal(reMounted.retry, retry);
  const unrelated = callback("submissionHandoff", {
    scopeKey: "other\0session",
    workspacePath: "other",
    workspaceIdentity: undefined,
    options: { submissionOwner: Symbol("other") },
  });
  assert.equal(unrelated(store.useComposerAttachmentUploadStore.getState()), undefined);
  store.setComposerAttachmentHandoff(h.scopeKey, undefined, Symbol("late-other-owner"));
  assert.equal(select(store.useComposerAttachmentUploadStore.getState()), reMounted);
  fail = false;
  await reMounted.retry();
  assert.deepEqual(
    calls.filter((c) => c.startsWith("adopt:")),
    ["adopt:one", "adopt:two", "adopt:two"],
  );
  assert.ok(
    store
      .readComposerAttachmentScope(h.scopeKey)
      .every(
        (item) =>
          item.adopted &&
          item.referenceOwnership === "session" &&
          !item.handoffPending &&
          !item.submissionTransfer,
      ),
  );
  store.setComposerAttachmentHandoff(h.scopeKey, undefined, token);
  assert.equal(select(store.useComposerAttachmentUploadStore.getState()), undefined);
});

test("definite rejection releases the original operation without adopting it", async () => {
  store.useComposerAttachmentUploadStore.setState({ scopes: {}, handoffs: {} });
  const h = owner();
  let releases = 0;
  store.updateComposerAttachmentScope(h.scopeKey, () => [
    {
      id: "one",
      operationId: "one",
      staged: true,
      adopted: false,
      submissionTransfer: {
        async reserveForSubmission() {},
        async releaseSubmissionReservation() {
          releases++;
        },
      },
      referenceOwnership: "composer",
    },
  ]);
  await h.reserve(["one"]);
  await h.release(["one"]);
  assert.equal(releases, 1);
  const [item] = store.readComposerAttachmentScope(h.scopeKey);
  assert.equal(item.handoffPending, false);
  assert.equal(item.adopted, false);
  assert.equal(item.referenceOwnership, "composer");
});
