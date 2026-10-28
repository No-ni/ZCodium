import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

const root = new URL("../../", import.meta.url);
const pane = "packages/ui/src/v4/SessionPane.tsx";
const owner = "packages/ui/src/v4/composer/useDraftConfigControl.ts";
const original = Object.freeze({
  providerId: "fixture-api",
  modelId: "model-b",
  options: Object.freeze({ reasoningLevel: "high" }),
});
const view = {
  revision: 1,
  providers: [
    {
      providerId: "fixture-api",
      models: [
        {
          modelId: "model-a",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
        {
          modelId: "model-b",
          config: { optionSpecs: { reasoningLevel: { values: ["off", "medium", "high"] } } },
        },
      ],
    },
  ],
};
const context = { provider: "fixture-api", model: "model-b" };

async function createOwner(initial = { modelSelection: original, thought: "high" }) {
  const draftConfigRef = { current: initial };
  const modelSelectionViewRef = { current: view };
  const stateRef = { current: { scopeKey: "fixture-scope" } };
  let writes = 0;
  const callback = await loadComponentCallback(owner, "handleDraftSelectThought", {
    draftConfigRef,
    modelSelectionViewRef,
    stateRef,
    scopeKey: "fixture-scope",
    updateDraftConfig: (update) => {
      writes += 1;
      draftConfigRef.current = update(draftConfigRef.current);
    },
  });
  return { callback, draftConfigRef, modelSelectionViewRef, stateRef, writes: () => writes };
}

test("SessionPane passes the operation model context to the one draft owner", async () => {
  const calls = [];
  const callback = await loadComponentCallback(pane, "handleSelectThought", {
    handleDraftSelectThought: (...args) => calls.push(args),
  });
  callback("medium", context);
  assert.deepEqual(calls, [["medium", context]]);
});

test("an old A effort callback cannot write to the newly selected B", async () => {
  const control = await createOwner();
  control.callback("low", { provider: "fixture-api", model: "model-a" });
  assert.equal(control.draftConfigRef.current.modelSelection, original);
  assert.equal(control.writes(), 0);
  control.callback("medium", context);
  assert.deepEqual(control.draftConfigRef.current.modelSelection, {
    providerId: "fixture-api",
    modelId: "model-b",
    options: { reasoningLevel: "medium" },
  });
  assert.equal(control.writes(), 1);
});

test("empty, unsupported and unchanged effort events do not persist a draft", async () => {
  const control = await createOwner();
  for (const value of ["", " ", "unsupported", "low", "high"]) control.callback(value, context);
  assert.equal(control.draftConfigRef.current.modelSelection, original);
  assert.equal(control.draftConfigRef.current.thought, "high");
  assert.equal(control.writes(), 0);
});

test("a flat historical provider/model alias cannot manufacture a structured selection", async () => {
  const initial = { mode: "build", provider: "fixture-api", model: "model-b" };
  const control = await createOwner(initial);
  control.callback("medium", context);
  assert.equal(control.draftConfigRef.current, initial);
  assert.equal(control.writes(), 0);
});

test("thought interaction waits for the latest ready target view, not a retained catalog", async () => {
  const control = await createOwner();
  control.modelSelectionViewRef.current = null;
  control.callback("medium", context);
  assert.equal(control.writes(), 0);
  control.modelSelectionViewRef.current = view;
  control.callback("medium", context);
  assert.equal(control.writes(), 1);
});

test("a delayed callback rechecks the latest capabilities rather than its captured view", async () => {
  const control = await createOwner();
  control.modelSelectionViewRef.current = { revision: 2, providers: [] };
  control.callback("medium", context);
  assert.equal(control.writes(), 0);
});

test("an old scope callback cannot write the newly selected session even for the same model", async () => {
  const control = await createOwner();
  control.stateRef.current.scopeKey = "new-fixture-scope";
  control.callback("medium", context);
  assert.equal(control.writes(), 0);
});

test("toolbar consumes the combined menu while preserving the owner and submission freeze", async () => {
  const toolbar = await readFile(
    new URL("packages/ui/src/v4/composer/V4ComposerToolbar.tsx", root),
    "utf8",
  );
  const selectionHook = await readFile(
    new URL("packages/ui/src/hooks/useModelSelectionView.ts", root),
    "utf8",
  );
  assert.match(toolbar, /composerOptions=\{composerOptions\}/);
  assert.doesNotMatch(toolbar, /<ThoughtLevelCycleControl/);
  assert.match(selectionHook, /catalog\?: ModelSelectionCatalog/);
  assert.doesNotMatch(
    toolbar,
    /useComposerConnectionSwitch|useUsageEntitlement|useCodingPlanUpgradeDialog|providerMenu|highspeed/,
  );
  const freeze = await readFile(
    new URL("packages/ui/src/v4/composer/composerSubmissionConfig.ts", root),
    "utf8",
  );
  assert.match(
    freeze,
    /Object\.freeze\(\{ reasoningLevel: selection\.options!\.reasoningLevel! \}\)/,
  );
});
