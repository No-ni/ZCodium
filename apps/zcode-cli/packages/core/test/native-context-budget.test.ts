import assert from "node:assert/strict";
import test from "node:test";
import { createRecommendedNativeContextConfiguration } from "@zcode/shared/native-context-compression";
import type { Model } from "@zcode/contracts";
import {
  nativeInputBudget,
  validateNativeModelThresholds,
} from "../src/runtime/native-context-compression/budgets.js";

const model = {
  properties: { contextWindow: 20_000 },
  optionSpecs: { maxOutputTokens: { max: 4000 } },
} as Model;
test("mixed token/percent thresholds use the real available input budget", () => {
  const parameters = createRecommendedNativeContextConfiguration().parameters;
  parameters.trigger.start = { kind: "tokens", value: 9000 };
  parameters.trigger.target = { kind: "percent", value: 50 };
  parameters.trigger.opportunisticPercent = 50;
  assert.equal(validateNativeModelThresholds(parameters, model), 16_000);
  parameters.trigger.start.value = 1000;
  assert.throws(() => validateNativeModelThresholds(parameters, model), /model-threshold-target/u);
});
test("absolute starts above capacity are rejected before paid maintenance", () => {
  const parameters = createRecommendedNativeContextConfiguration().parameters;
  parameters.trigger.start = { kind: "tokens", value: 19_000 };
  assert.throws(
    () => validateNativeModelThresholds(parameters, model),
    /model-threshold-capacity/u,
  );
});
test("missing or exhausted model input capacity stays unknown", () => {
  assert.equal(nativeInputBudget({ ...model, properties: { contextWindow: 0 } } as Model), null);
  assert.equal(nativeInputBudget({ ...model, properties: { contextWindow: 4000 } } as Model), null);
});
