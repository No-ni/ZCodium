import assert from "node:assert/strict";
import test from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

test("all settings capability counts reject late notifications from a retired scope", async () => {
  for (const name of [
    "updatePluginCount",
    "updateMcpCount",
    "updateSkillCount",
    "updateCommandCount",
  ]) {
    const capabilityScopeRef = { current: "scope-a" };
    let counts = { plugins: 0, mcps: 0, skills: 0, commands: 0 };
    const callback = await loadComponentCallback(
      "packages/ui/src/settings/PluginsSection.tsx",
      name,
      {
        capabilityScopeRef,
        capabilityScopeKey: "scope-a",
        setCapabilityCounts: (update) => (counts = update(counts)),
      },
    );
    callback(3);
    assert.equal(
      Object.values(counts).reduce((sum, count) => sum + count, 0),
      3,
    );
    capabilityScopeRef.current = "scope-b";
    callback(99);
    assert.equal(
      Object.values(counts).reduce((sum, count) => sum + count, 0),
      3,
    );
  }
});
