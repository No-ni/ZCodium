import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProjectTestFixture } from "../project-test-sandbox.mjs";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { ServiceCollection } = await tsImport(
  "../../../packages/services/src/collection.ts",
  import.meta.url,
);
const { ISourceWorkspaceInspectionService } = await tsImport(
  "../../../packages/services/src/source-server-workspace/index.ts",
  import.meta.url,
);
const { createNodeSourceWorkspaceInspectionService } = await tsImport(
  "../../../packages/services/src/source-server-workspace/node.ts",
  import.meta.url,
);
const { createCoreHttpServer } = await tsImport(
  "../../../packages/zcode-server-cli/src/server-core/http.ts",
  import.meta.url,
);
const { connectSourceServerRpc } = await tsImport(
  "../../../packages/desktop/src/host/sourceServerRpc.ts",
  import.meta.url,
);
const { assertSourceWorkspaceAdmission } = await tsImport(
  "../../../packages/desktop/src/host/sourceWorkspaceAdmission.ts",
  import.meta.url,
);
const { buildServerRemoteWorkspaceIdentity } = await tsImport(
  "../../../packages/shared/src/remote-workspace-identity.ts",
  import.meta.url,
);
const scope = { sourceServerId: "fixture-source", workspacePath: "/fixture" };
const clear = {
  ...scope,
  schemaVersion: 1,
  stableIdentity: buildServerRemoteWorkspaceIdentity({
    serverId: scope.sourceServerId,
    workspacePath: scope.workspacePath,
  }),
  state: "clear",
};
function service(result = clear, capability = { version: 1 }) {
  return {
    async getCapabilities() {
      return capability;
    },
    async inspect() {
      return result;
    },
  };
}
function options(instance) {
  return { service: instance, scope, async assertCurrent() {} };
}

test("Host verifies exact Source scope, stable identity, strict capability and safe result", async () => {
  await assertSourceWorkspaceAdmission(options(service()));
  for (const result of [
    { ...clear, sourceServerId: "other" },
    { ...clear, workspacePath: "/other" },
    { ...clear, stableIdentity: "fake" },
    { ...clear, dataRoot: "/leak" },
    { ...clear, state: "history-present", reason: "source-workspace-history-present" },
    { ...clear, state: "unavailable", reason: "source-workspace-inspection-unavailable" },
  ])
    await assert.rejects(assertSourceWorkspaceAdmission(options(service(result))));
  for (const capability of [{ version: 2 }, { version: 1, secret: "extra" }, null])
    await assert.rejects(assertSourceWorkspaceAdmission(options(service(clear, capability))));
  await assert.rejects(assertSourceWorkspaceAdmission(options(undefined)));
});
test("Profile retirement or cancellation after Source response refuses admission", async () => {
  let checks = 0;
  await assert.rejects(
    assertSourceWorkspaceAdmission({
      ...options(service()),
      async assertCurrent() {
        checks++;
        if (checks === 2) throw new Error("retired");
      },
    }),
    /retired/,
  );
  const controller = new AbortController();
  await assert.rejects(
    assertSourceWorkspaceAdmission({
      ...options({
        ...service(),
        async inspect() {
          controller.abort();
          return clear;
        },
      }),
      signal: controller.signal,
    }),
  );
});
for (const enabled of [false, true])
  test(`loopback Source advertises and privately exposes inspection only when ${enabled ? "registered" : "present in no service"}`, async (t) => {
    const temp = await createProjectTestFixture("source-inspection-rpc");
    const dataRoot = join(temp, ".zcodium");
    await mkdir(dataRoot);
    const taskDatabasePath = join(dataRoot, "v2", "tasks-index.sqlite");
    const services = new ServiceCollection();
    if (enabled)
      services.register(
        ISourceWorkspaceInspectionService,
        createNodeSourceWorkspaceInspectionService({
          sourceServerId: scope.sourceServerId,
          dataRoot,
          taskDatabasePath,
          sessionDatabasePath: join(dataRoot, "cli", "db", "db.sqlite"),
        }),
      );
    const ingressToken = "a".repeat(64);
    const http = await createCoreHttpServer(services, {
      serverId: scope.sourceServerId,
      ingressToken,
    });
    t.after(() => http.close());
    const transport = {
      ingressToken,
      openChannel: async () => createConnection({ host: "127.0.0.1", port: http.port }),
    };
    const connection = await connectSourceServerRpc(transport);
    try {
      assert.equal(
        connection.serverInfo.capabilities.sourceWorkspaceInspectionV1,
        enabled ? true : undefined,
      );
      assert.equal(Boolean(connection.workspaceInspection), enabled);
      assert.equal(
        Object.prototype.hasOwnProperty.call(connection.services, "workspaceInspection"),
        false,
        "inspection is not a Renderer accessor",
      );
      if (enabled) {
        assert.deepEqual(await connection.workspaceInspection.inspect(scope), clear);
        await assertSourceWorkspaceAdmission(options(connection.workspaceInspection));
        await mkdir(join(dataRoot, "v2"));
        await writeFile(taskDatabasePath, "not a database; must not be opened");
        const result = await connection.workspaceInspection.inspect(scope);
        assert.equal(result.state, "history-present");
        assert.equal(JSON.stringify(result).includes(dataRoot), false);
        await assert.rejects(
          assertSourceWorkspaceAdmission(options(connection.workspaceInspection)),
        );
      }
    } finally {
      connection.dispose();
    }
    const response = await fetch(`http://127.0.0.1:${http.port}/api/server-info`, {
      headers: { authorization: `Bearer ${ingressToken}` },
    });
    assert.equal(response.status, 200, "attachment disposal does not stop Source");
  });
