import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

test("launcher surfaces come only from the current known plugin manifest", async () => {
  const text = await readFile(
    "packages/ui/src/plugin-ui/adapters/useRecommendedUiPlugins.ts",
    "utf8",
  );
  const source = ts.createSourceFile("local.ts", text, ts.ScriptTarget.Latest, true);
  const helper = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "collectKnownPluginUiSurfaces",
  );
  assert.ok(helper, "known manifests need a local projection without retired rollout config");
  const { outputText } = ts.transpileModule(helper.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  });
  const collect = new Function(`${outputText}; return collectKnownPluginUiSurfaces;`)();
  const known = {
    id: "local-plugin",
    info: { uiSurfaces: [{ id: "panel" }, { id: "panel" }, { id: "other" }] },
  };
  const entries = collect([{ id: "catalog-only" }, known]);
  assert.deepEqual(
    entries.map(({ pluginId, surfaceId }) => [pluginId, surfaceId]),
    [
      ["local-plugin", "panel"],
      ["local-plugin", "other"],
    ],
  );
  assert.ok(entries.every((entry) => entry.item === known));
});

test("store directory ordering does not read the retired cloud recommendation hook", async () => {
  const source = await readFile("packages/ui/src/settings/PluginStoreListView.tsx", "utf8");
  assert.ok(!source.includes("useUiPluginRecommendations"));
  assert.match(source, /segmentItems\.filter\(isUiPluginItem\)/);
});

test("Timeline publishes through the existing lifecycle adapter", async () => {
  const source = await readFile("packages/ui/src/v4/ConversationTimeline.tsx", "utf8");
  assert.match(source, /usePublishPluginUiInstanceDerivation\(sessionKey, pluginUiDerivation\)/);
  assert.ok(!source.includes("setPluginUiInstanceDerivation"));
});
