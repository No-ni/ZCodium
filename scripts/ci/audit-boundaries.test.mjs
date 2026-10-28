import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const repoRoot = new URL("../..", import.meta.url);

const { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } = await tsImport(
  "../../packages/shared/src/plugin-marketplaces.ts",
  import.meta.url,
);
const { isLocalResourceMonitoringEnabled } = await tsImport(
  "../../packages/shared/src/runtimeEnv.ts",
  import.meta.url,
);
const { OFFICIAL_PLUGIN_DEFINITIONS } = await tsImport(
  "../../apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
  import.meta.url,
);

function read(relativePath) {
  return readFileSync(new URL(relativePath, repoRoot), "utf8");
}

function grepFiles(pattern, paths = ["packages", "apps", "config"]) {
  try {
    const output = execFileSync("git", ["grep", "-l", "-F", pattern, "--", ...paths], {
      cwd: new URL(".", repoRoot),
      encoding: "utf8",
    }).trim();
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
  } catch (error) {
    if (error && error.status === 1) return [];
    throw error;
  }
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test("official control-plane and OAuth fallbacks stay removed", () => {
  for (const pattern of [
    "DEFAULT_ZCODE_ENDPOINT_ORIGIN",
    "DEFAULT_ZAI_OAUTH",
    "ZAI_OAUTH_",
    "ZAI_BUSINESS_BASE_URL",
  ]) {
    assert.deepEqual(grepFiles(pattern), [], `${pattern} must not appear in production code`);
  }

  const subscriptionService = read(
    "packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts",
  );
  assert.doesNotMatch(subscriptionService, /readApiJson|apiClient|buildRuntimeZCodeApiUrl/);
  assert.match(subscriptionService, /resolveDynamicWorkflowClientConfig/);

  const updateGuard = read("packages/desktop/src/main/forceUpdateGuard.ts");
  assert.match(updateGuard, /ZCODIUM_UPDATE_ORIGIN/);
  assert.doesNotMatch(updateGuard, /DEFAULT_ZCODE|zcode\.z\.ai/);
});

test("official account providers and purchase webviews stay removed", () => {
  const builtin = readJson("config/provider/zcode-builtin.json");
  const providerRules = builtin.config?.providerConfigRules?.providerRules ?? [];
  const templateRules = builtin.config?.providerConfigRules?.templateRules ?? [];
  const modelRules = builtin.config?.modelConfigRules?.builtinProviderModelRules ?? [];

  assert.equal(
    providerRules.filter((provider) => provider?.access?.type === "zhipu-account").length,
    0,
  );
  assert.equal(
    providerRules.filter((provider) => String(provider?.id ?? "").startsWith("account:")).length,
    0,
  );
  assert.equal(
    modelRules.filter((rule) => String(rule?.providerId ?? "").startsWith("account:")).length,
    0,
  );
  assert.ok(Number(builtin.revision) >= 32);
  for (const id of ["zai-api", "zai-standard-api", "bigmodel-api", "bigmodel-standard-api"]) {
    assert.ok(
      templateRules.some((rule) => rule?.templateId === id),
      `${id} API-key template must remain`,
    );
  }

  for (const pattern of [
    "CodingPlanWebview",
    "ClearCodingPlanWebviewStorage",
    "CODING_PLAN_WEBVIEW_PARTITION",
    "VITE_REWARDS_WEBVIEW",
  ]) {
    assert.deepEqual(grepFiles(pattern), [], `${pattern} must not be reintroduced`);
  }
});

test("BYO API-key quota is the only remaining provider quota path", () => {
  assert.deepEqual(grepFiles("/api/monitor/usage/quota/limit"), [
    "packages/services/src/usage-stats/codingPlanQuota.ts",
  ]);
});

test("product links point at this fork", () => {
  const help = readJson("config/default.json");
  assert.match(help.feedback_url, /^https:\/\/github\.com\/No-ni\/ZCodium\/issues\/new$/);
  for (const locale of ["zh-CN", "en-US"]) {
    assert.equal(help.community_urls?.[locale], "https://github.com/No-ni/ZCodium");
  }

  const builder = read("packages/desktop/electron-builder.config.js");
  assert.match(builder, /homepage: "https:\/\/github\.com\/No-ni\/ZCodium"/);
  assert.doesNotMatch(builder, /zcode\.z\.ai/);
});

test("official plugin defaults match the CLI definitions", () => {
  const expected = OFFICIAL_PLUGIN_DEFINITIONS.filter((definition) => definition.defaultEnabled)
    .map((definition) => `${definition.name}@zcode-plugins-official`)
    .sort();
  assert.deepEqual([...DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS].sort(), expected);
});

test("maintenance commands and release defaults preserve official-only ownership", async () => {
  const maintenance = read("docs/specs/maintenance-model.md");
  assert.match(maintenance, /git fetch --no-tags upstream/);
  assert.match(maintenance, /refs\/tags\/\*:refs\/upstream-tags\/\*/);
  assert.doesNotMatch(maintenance, /git fetch upstream --tags|git fetch --tags upstream/);
  const { default: release } = await import("../../.release-it.mjs");
  assert.equal(release.git.push, false);
  assert.equal(release.git.pushRepo, "origin");
  assert.match(release.git.commitMessage, /发布/);
  assert.equal(release.github.release, false);
  for (const file of ["README.md", "README.en.md"]) {
    const source = read(file);
    assert.match(source, /workflow_dispatch/);
    for (const artifact of [
      "desktop-win-x64",
      "desktop-win-arm64",
      "desktop-mac-arm64",
      "desktop-mac-x64",
    ]) {
      assert.ok(source.includes(artifact), `${file} omits ${artifact}`);
    }
    assert.doesNotMatch(source, /creates a \*\*draft Release|创建\*\*草稿 Release|oauth\/token/);
  }
  for (const file of [
    "upstream-sync-3.15.1.md",
    "upstream-parity-audit.md",
    "upstream-i18n-parity.md",
  ]) {
    assert.match(read(`.agents/specs/${file}`).split("\n").slice(0, 6).join("\n"), /历史/);
  }
});

test("document plugin license and seed versions match their source manifests", () => {
  for (const [name, skill] of [
    ["documents", "docx"],
    ["pdf", "pdf"],
    ["spreadsheets", "xlsx"],
    ["presentations", "pptx"],
  ]) {
    const root = `apps/zcode-cli/packages/${name}-plugin`;
    const manifest = readJson(`${root}/.zcodium-plugin/plugin.json`);
    const pkg = readJson(`${root}/package.json`);
    assert.equal(manifest.version, pkg.version);
    assert.equal(
      OFFICIAL_PLUGIN_DEFINITIONS.find((plugin) => plugin.name === name)?.version,
      pkg.version,
    );
    assert.equal(manifest.license, "Apache-2.0");
    assert.match(read(`${root}/skills/${skill}/SKILL.md`), /license: Apache-2\.0/);
    assert.match(read(`${root}/skills/${skill}/LICENSE.txt`), /Apache License/);
  }
  assert.deepEqual(grepFiles("z-cdn.chatglm.cn/office-skill/fonts"), []);
});

test("AstrBot uses the existing platform callback and this fork's documentation", () => {
  const card = read("packages/ui/src/BotsDialog/AstrBotSettingsCard.tsx");
  assert.match(card, /ASTRBOT_PLUGIN_URL = ASTRBOT_BRIDGE_DOCS_URL/);
  assert.doesNotMatch(card, /axiom-desu/);
  assert.match(
    read("packages/ui/src/lib/productDocs.ts"),
    /https:\/\/github\.com\/No-ni\/ZCodium\/blob\/main\/docs\/astrbot-bridge\.md/,
  );
  assert.match(
    read("packages/ui/src/BotsDialog.tsx"),
    /onOpenPlugin=\{\(\) => platform\.openExternal\(ASTRBOT_PLUGIN_URL\)\}/,
  );
  assert.match(read("docs/astrbot-bridge.md"), /独立第三方项目/);
});

test("background resource and network sampling is opt-in and local-only", () => {
  assert.equal(isLocalResourceMonitoringEnabled({}), false);
  assert.equal(isLocalResourceMonitoringEnabled({ ZCODE_LOCAL_RESOURCE_MONITORING: "0" }), false);
  assert.equal(isLocalResourceMonitoringEnabled({ ZCODE_LOCAL_RESOURCE_MONITORING: "1" }), true);

  for (const file of [
    "packages/desktop/src/main/index.ts",
    "packages/desktop/src/host/index.ts",
    "packages/desktop/src/scheduler/index.ts",
    "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/maintenance.ts",
  ]) {
    assert.match(read(file), /isLocalResourceMonitoringEnabled/, `${file} must gate sampling`);
  }

  const mainIndex = read("packages/desktop/src/main/index.ts");
  assert.match(
    mainIndex,
    /if \(isLocalResourceMonitoringEnabled\(\)\) \{\s*registerDesktopResourceTelemetry/,
  );
});
