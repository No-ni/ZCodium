import assert from "node:assert/strict";
import { it } from "node:test";
import { analyzeWorkflowScript, lowerWorkflowScript } from "../src/index.js";

it("model names form a closed collection, including helpers and literal unions", () => {
  const analysis = analyzeWorkflowScript(`
const refs = [model("fast"), model("deep")] as const;
const name = true ? "one" : "two";
const a = agent("a", { model: name });
const b = agent("b", { model: refs[0] });
return await a.ask("hello");`);
  assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
  assert.deepEqual(
    new Set(analysis.modelReferences.map((ref) => ref.name)),
    new Set(["fast", "deep", "one", "two"]),
  );
  const lowered = lowerWorkflowScript('const m = model("fast"); agent("a", { model: m });');
  assert.equal(lowered.ok, true);
  assert.match(lowered.lowered!.code, /const m = "fast"/);
  assert.doesNotMatch(lowered.lowered!.code, /__host\.model/);
});

it("9010 rejects widened, empty, forged, and value-position model references", () => {
  for (const script of [
    'let name = "fast"; agent("a", { model: name });',
    'const p = { model: "fast" }; agent("a", p);',
    'model(" ");',
    'const name = "fast"; model(name);',
    'const ref = model("fast"); return ref instanceof ModelRef;',
    'agent("a", { model: "" });',
  ]) {
    const result = analyzeWorkflowScript(script);
    assert.equal(result.ok, false, script);
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === 9010),
      JSON.stringify(result.diagnostics),
    );
  }
});

it("inline shorthand, spread override and optional literal persona types retain exact names", () => {
  for (const script of [
    'const model = "fast"; agent("a", { model });',
    'const p = { model: "fast" } as const; agent("a", { ...p });',
    'const p: { model?: "fast" | "deep" } = {}; agent("a", p);',
  ])
    assert.equal(analyzeWorkflowScript(script).ok, true, script);
});
