import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { tsImport } from "tsx/esm/api";

test("E2E startup initializes anonymous credentials without retired account seeds", async () => {
  const source = await readFile("packages/desktop/wdio.conf.ts", "utf8");
  const file = ts.createSourceFile("wdio.ts", source, ts.ScriptTarget.Latest, true);
  const writes = [];
  function visit(n) {
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(file) === "writeFileSync" &&
      n.arguments[0]?.getText(file) === "E2E_APP_CREDENTIALS_FILE"
    )
      writes.push(n);
    ts.forEachChild(n, visit);
  }
  visit(file);
  assert.equal(writes.length, 1);
  const json = writes[0].arguments[1];
  assert.equal(json.expression.getText(file), "JSON.stringify");
  assert.ok(ts.isObjectLiteralExpression(json.arguments[0]));
  assert.equal(json.arguments[0].properties.length, 0);
  for (const path of [
    "request-security-edition",
    "e2e-startup-credentials",
    "e2e-provider-endpoint",
  ])
    assert.ok(!source.includes(path), `retired ${path} must not be loaded`);
  assert.ok(!source.includes("startOffPeakMockGateway"));
  assert.ok(!source.includes("startOffPeakMockIfNeeded"));
  for (const retired of [
    "startCodingPlanTeamMockIfNeeded",
    "startCodingPlanUpgradeE2EMock",
    "createCorruptOAuthCredentialSeed",
    "OFFPEAK_SUBAGENT_MODEL_INHERITANCE_SPEC",
  ])
    assert.ok(!source.includes(retired), `retired ${retired} must not be loaded`);
});

test("retiring the empty official header policy preserves Provider credential redaction", async () => {
  const { sanitizeE2ENetworkCaptureHeaders } = await tsImport(
    "../../packages/desktop/test/e2e/helpers/e2e-network-capture-redaction.ts",
    import.meta.url,
  );
  const result = sanitizeE2ENetworkCaptureHeaders({
    Authorization: "fixture-key",
    "X-API-Key": "fixture-key",
    cookie: "fixture-cookie",
    "content-type": "application/json",
  });
  assert.deepEqual(result, {
    authorization: "[redacted]",
    "x-api-key": "[redacted]",
    cookie: "[redacted]",
    "content-type": "application/json",
  });
});
