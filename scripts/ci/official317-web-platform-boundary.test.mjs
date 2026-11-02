import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const repoRoot = new URL("../..", import.meta.url);

const PLATFORM_CONTRACT = "packages/web/src/platform/contract.ts";
const PLATFORM_INDEX = "packages/web/src/platform/index.ts";
const SHARED_PLATFORM = "packages/shared/src/platform.ts";

/**
 * 本 fork 已按审计边界退休官方 3.17.1 的遥测与账号/OAuth 端口，shared 不再导出这些符号，
 * IPlatformService 也不再声明对应方法。web 平台适配若继续引用，根 typecheck 会直接失败，
 * 且等于把已剥离的官方上报链路重新接回 renderer，因此这里作为长期边界守护。
 */
const RETIRED_REFERENCES = [
  "RendererTelemetryEventPayload",
  "mobilePluginDiscoveryTelemetrySchema",
  "sessionCreateTelemetrySchema",
  "registerOAuthState",
  "onOAuthCallback",
  "onPaymentCallback",
  "onShareImport",
  "reportTelemetryEvent",
  "reportArmsCustomEvent",
  "getDeviceId",
];

function read(relativePath) {
  return readFileSync(new URL(relativePath, repoRoot), "utf8");
}

/**
 * IPlatformService 是纯类型接口，运行时没有可导入的导出，只能按声明文本提取成员名与可选性。
 * 只认两空格缩进的顶层成员，签名内部的嵌套对象类型不会误入。
 */
function parseContractMembers(source) {
  const start = source.indexOf("export interface IPlatformService {");
  assert.ok(start >= 0, "IPlatformService contract must exist in shared/platform.ts");
  const bodyStart = source.indexOf("\n", start) + 1;
  let depth = 1;
  let index = bodyStart;
  while (index < source.length && depth > 0) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
    index += 1;
  }
  const body = source.slice(bodyStart, index - 1);
  const members = new Map();
  for (const match of body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*[(:]/gm)) {
    members.set(match[1], { name: match[1], optional: match[2] === "?" });
  }
  return members;
}

/** 提取 web 平台对象字面量实现的成员名；async 方法同样计入。 */
function parseImplementedMembers(source) {
  const objectStart = source.indexOf("return {");
  assert.ok(objectStart >= 0, "createWebPlatform must return the platform object literal");
  const names = [];
  for (const match of source
    .slice(objectStart)
    .matchAll(/^ {4}(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*[(:]/gm)) {
    names.push(match[1]);
  }
  return names;
}

test("web platform adapter stops referencing retired telemetry and OAuth ports", () => {
  for (const file of [PLATFORM_CONTRACT, PLATFORM_INDEX]) {
    const source = read(file);
    for (const symbol of RETIRED_REFERENCES) {
      assert.ok(!source.includes(symbol), `${file} must not reference retired symbol ${symbol}`);
    }
  }
});

test("web platform proxy routes exactly the shared remote-control method whitelist", async () => {
  const { webRemoteControlPlatformMethodSchema } = await tsImport(
    "../../packages/shared/src/webRemoteControl/envelope.ts",
    import.meta.url,
  );
  const whitelist = [...webRemoteControlPlatformMethodSchema.options].sort();

  const contract = read(PLATFORM_CONTRACT);
  assert.match(
    contract,
    /WebRemoteControlPlatformMethod/,
    "proxy must stay scoped to the whitelist type",
  );
  assert.match(
    contract,
    /IPlatformService/,
    "proxy args/results must derive from the real platform contract",
  );

  const index = read(PLATFORM_INDEX);
  const routed = [
    ...new Set(
      [...index.matchAll(/requestPlatformMethod\(\s*"([A-Za-z]+)"/g)].map((match) => match[1]),
    ),
  ].sort();
  assert.deepEqual(
    routed,
    whitelist,
    "web platform must route every whitelisted method and nothing else",
  );
});

test("web platform object literal satisfies the real IPlatformService contract", () => {
  const contractMembers = parseContractMembers(read(SHARED_PLATFORM));
  const implemented = parseImplementedMembers(read(PLATFORM_INDEX));

  const dead = implemented.filter((name) => !contractMembers.has(name));
  assert.deepEqual(dead, [], "web platform implements members IPlatformService no longer declares");

  const missingRequired = [...contractMembers.values()]
    .filter((member) => !member.optional && !implemented.includes(member.name))
    .map((member) => member.name);
  assert.deepEqual(missingRequired, [], "web platform misses required IPlatformService members");
});
