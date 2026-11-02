import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(
  new URL("../../packages/services/src/node.ts", import.meta.url),
  "utf8",
);

test("Host does not export retired official CUA installers or full network capture", () => {
  assert.doesNotMatch(
    source,
    /createCuaHelperInstaller|requestHelperAccessibilityPermissionViaLaunchServices|requestHelperScreenRecordingPermissionViaLaunchServices|cuaHelperInstaller\.js|localRuntimeNetworkCapture/,
  );
});
test("Bot remote assembly uses one existing Source connection owner", () => {
  assert.doesNotMatch(source, /createBotRemoteWorkspaceService/);
  assert.equal((source.match(/const botRemoteWorkspaceService\s*=/g) ?? []).length, 1);
  assert.match(source, /createBotProjectRuntime\(/);
});
test("Host assembly has no plugin telemetry or automatic model recording", () => {
  assert.doesNotMatch(
    source,
    /reportPluginTelemetryEvent|modelIoFullRetentionEnabled|resolveClientLanguage/,
  );
});
test("Host archive state is not passed to the CLI session query", () => {
  assert.doesNotMatch(source, /includeArchived\s*:/);
  assert.match(source, /sessionIds:\s*\[scope\.sessionId\]/);
});
test("Plugin management has one service registration", () => {
  assert.equal((source.match(/\.register\(\s*IPluginManagementService\s*,/g) ?? []).length, 1);
});
