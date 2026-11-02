import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { SourceServerDirectory } from "../../packages/desktop/src/host/sourceServerDirectory.ts";
import { ServiceCollection, IProjectService } from "../../packages/services/src/index.ts";

test("HTTP server cannot create a Source process profile or touch its settings/credentials", async () => {
  let reads = 0,
    writes = 0;
  const directory = new SourceServerDirectory({
    settingService: {
      async get() {
        reads++;
        return {};
      },
      async update() {
        writes++;
      },
    },
    credentialService: {
      async load() {
        reads++;
      },
      async save() {
        writes++;
      },
      async delete() {
        writes++;
      },
    },
  });
  await assert.rejects(
    directory.ensureProfile({ kind: "server", url: "http://fixture.invalid", token: "fixture" }),
    /unsupported/,
  );
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  directory.dispose();
});

test("remote Bot assembly obtains the real local ProjectService and fails without an owner", async () => {
  const source = await readFile(
    new URL("../../packages/desktop/src/host/remoteWorkspaceServiceCollection.ts", import.meta.url),
    "utf8",
  );
  const file = ts.createSourceFile("remote.ts", source, ts.ScriptTarget.Latest, true);
  const fn = file.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "createRemoteWorkspaceServiceCollection",
  );
  const start = fn.body.statements.findIndex(
    (n) => ts.isIfStatement(n) && n.expression.getText(file) === "!params.sourceServices",
  );
  assert.ok(start >= 0);
  const block = fn.body.statements
    .slice(start, start + 2)
    .map((n) => n.getText(file))
    .join("\n");
  const execute = new Function(
    "params",
    "IProjectService",
    ts.transpileModule(block + "\nreturn projectService;", {
      compilerOptions: { target: ts.ScriptTarget.ESNext },
    }).outputText,
  );
  const owner = {
    readProjects: async () => [],
    readTree: async () => [],
    prepareSession: async () => ({}),
  };
  assert.equal(
    execute(
      { sourceServices: new ServiceCollection().register(IProjectService, owner) },
      IProjectService,
    ),
    owner,
  );
  assert.throws(() => execute({}, IProjectService), /Local project owner unavailable/);
  assert.match(
    source,
    /createBotsService\(\{\s*credentialService: localCredentialService,\s*projectService,/,
  );
});
