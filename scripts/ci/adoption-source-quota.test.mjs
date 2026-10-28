import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { tsImport } from "tsx/esm/api";
const { createUsageStatsService } = await tsImport(
  "../../packages/services/src/usage-stats/usageStatsService.ts",
  import.meta.url,
);

async function createSourceServices(dependencies) {
  const path = "../../packages/desktop/src/host/remoteWorkspaceServiceCollection.ts";
  const text = await readFile(new URL(path, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = source.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === "createStandaloneSourceServices",
  );
  assert.equal(functions.length, 1);
  const body = ts.transpileModule(functions[0].getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const names = [
    ...new Set([...text.matchAll(/\bI[A-Z]\w+(?:Service)\b/g)].map((match) => match[0])),
  ];
  const tokens = Object.fromEntries(names.map((name) => [name, name]));
  class ServiceCollection {
    entries = new Map();
    register(key, value) {
      this.entries.set(key, value);
      return this;
    }
    get(key) {
      return this.entries.get(key);
    }
  }
  const environment = {
    ...tokens,
    ServiceCollection,
    createBroadcastService: () => ({}),
    createCodingPlanSubscriptionService: () => ({}),
    registerRemoteProviderProvisioningExecutor() {},
    createRemoteProviderProvisioningExecutorFromWorkspace: () => ({}),
  };
  return new Function(
    ...Object.keys(environment),
    `${body}; return createStandaloneSourceServices;`,
  )(...Object.values(environment))({
    connectionServices: dependencies,
    parentPort: {},
    createReportingRemoteZCodeTaskService: (value) => value,
    createRemotePromptAttachmentTaskService: (value) => value,
    createRemotePromptAttachmentSessionService: (value) => value,
  });
}
function remoteQuota(key) {
  const calls = [];
  let providers = [
    {
      providerId: "fixture",
      providerName: "Fixture",
      enabled: true,
      personalConfig: {},
      models: [],
      effectiveConfig: {
        access: { type: "zhipu-coding-plan-api-key", apiKey: key },
        api: { baseUrl: "https://api.z.ai/api/anthropic" },
      },
    },
  ];
  const service = createUsageStatsService({
    zcodeAgentService: {
      async getAppUsageStats() {
        return {};
      },
    },
    providerSettingsService: {
      async getView() {
        return { revision: 1, providers };
      },
      onDidChange() {
        return { dispose() {} };
      },
    },
    apiClient: {
      async request(url, init) {
        calls.push({ url, authorization: init.headers.authorization });
        return {
          ok: true,
          status: 200,
          async json() {
            return { success: true, data: { limits: [] } };
          },
        };
      },
    },
  });
  return {
    service,
    calls,
    disappear() {
      providers = [];
    },
  };
}

test("standalone Source keeps the target Model, Provider and quota service owners", async () => {
  const quota = remoteQuota("target-fixture-key");
  const model = {};
  const provider = {};
  const services = await createSourceServices({
    usageStatsService: quota.service,
    modelSelectionService: model,
    providerSettingsService: provider,
  });
  assert.equal(services.get("IModelSelectionService"), model);
  assert.equal(services.get("IProviderSettingsService"), provider);
  assert.equal(services.get("IUsageStatsService"), quota.service);
  const context = await services.get("IUsageStatsService").getCodingPlanQuotaContext();
  assert.doesNotMatch(JSON.stringify(context), /target-fixture-key/);
  await services.get("IUsageStatsService").getCodingPlanQuota({ contextId: context.contextId });
  assert.equal(quota.calls.length, 1);
  assert.equal(quota.calls[0].authorization, "target-fixture-key");
});
test("equal Provider IDs on two Sources do not share quota contexts or credentials", async () => {
  const first = remoteQuota("first-source-fixture-key");
  const second = remoteQuota("second-source-fixture-key");
  const a = await createSourceServices({ usageStatsService: first.service });
  const b = await createSourceServices({ usageStatsService: second.service });
  const context = await a.get("IUsageStatsService").getCodingPlanQuotaContext();
  await assert.rejects(
    b.get("IUsageStatsService").getCodingPlanQuota({ contextId: context.contextId }),
    /context-changed/,
  );
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 0);
  const targetContext = await b.get("IUsageStatsService").getCodingPlanQuotaContext();
  assert.notEqual(targetContext.contextId, context.contextId);
  await b.get("IUsageStatsService").getCodingPlanQuota({ contextId: targetContext.contextId });
  assert.equal(second.calls[0].authorization, "second-source-fixture-key");
  assert.equal(first.calls.length, 0);
});
test("missing target quota capability never falls back to a Controller Key", async () => {
  const services = await createSourceServices({});
  assert.equal(services.get("IUsageStatsService"), undefined);
});
