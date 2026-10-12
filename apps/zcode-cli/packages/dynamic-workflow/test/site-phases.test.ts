import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeWorkflowScript,
  collectPhaseNames,
  collectSitePhases,
  type AnalyzeResult,
} from "../src/index.js";

/**
 * P3a 分析层留白集成：阶段表必须纳入留白名，`collectPhaseNames` 给出的 `holes` 下标必须
 * 指向被接受的那张 `phaseNames`；`collectSitePhases` 覆盖 issue 与 actor 两种出生事实。
 *
 * 这些用例是「P2 的 `openHoleIndexes` 现在能返回真实下标」的锚点：P2 的 `openHoleIndexes`
 * 按「开放留白名 → 阶段表」对下标，阶段表不含留白名时它恒回 `undefined`。这里用同一规则
 * （{@link p2OpenHoleIndexes}）复算，断言与 `collectPhaseNames(...).holes` 逐字相等。
 */
function analyzed(script: string): AnalyzeResult {
  const result = analyzeWorkflowScript(script);
  assert.ok(result.ok, JSON.stringify(result.diagnostics));
  return result;
}

/** P2 bootstrap 的规则逐字复刻（`openHoleIndexes`）：开放留白名在 `phaseNames` 里的下标。 */
function p2OpenHoleIndexes(phaseNames: readonly string[], openNames: readonly string[]): number[] {
  const open = new Set(openNames);
  const indexes: number[] = [];
  phaseNames.forEach((name, index) => {
    if (open.has(name)) indexes.push(index);
  });
  return indexes;
}

const OPEN_SCRIPT = [
  'phase("摸底");',
  'const x = await hole<string>("决定分组", "need a plan");',
  'phase("执行");',
  'return x;',
].join("\n");

describe("collectPhaseNames", () => {
  it("puts the hole's name in the phase table and indexes it as open", () => {
    const { flow } = analyzed(OPEN_SCRIPT);
    const { holes, phaseNames } = collectPhaseNames(flow);
    assert.deepEqual(phaseNames, ["摸底", "决定分组", "执行"]);
    assert.deepEqual(holes, [1]);
    // P2 的 openHoleIndexes 现在能返回真实下标（此前阶段表无留白名，恒为 undefined）。
    assert.deepEqual(p2OpenHoleIndexes(phaseNames, ["决定分组"]), holes);
    assert.ok(holes[0]! >= 0 && phaseNames[holes[0]!] === "决定分组");
  });

  it("returns an empty table for a script with no phase vocabulary", () => {
    const { flow } = analyzed("return 1;");
    assert.deepEqual(collectPhaseNames(flow), { holes: [], phaseNames: [] });
    assert.deepEqual(collectPhaseNames(undefined), { holes: [], phaseNames: [] });
  });

  it("keeps a filled hole's phase but no longer marks it open", () => {
    const { flow } = analyzed(
      'phase("摸底");\nconst x = await hole<string>("决定分组", "p", async () => "ok");\nphase("执行");\nreturn x;',
    );
    const { holes, phaseNames } = collectPhaseNames(flow);
    assert.deepEqual(phaseNames, ["摸底", "决定分组", "执行"]);
    assert.deepEqual(holes, []);
    assert.equal(flow?.holes, undefined);
  });

  it("indexes a nested open hole and stamps `fill` on the phases its body wrote", () => {
    const script = [
      'phase("A");',
      'const x = await hole<string>("outer", "p", async () => {',
      '  phase("B");',
      '  const y = await hole<string>("inner", "q");',
      '  phase("C");',
      '  return y;',
      '});',
      'phase("D");',
      'return x;',
    ].join("\n");
    const { flow } = analyzed(script);
    const { holes, phaseNames } = collectPhaseNames(flow);
    assert.deepEqual(phaseNames, ["A", "outer", "B", "inner", "C", "D"]);
    assert.deepEqual(holes, [3]);
    // 体内阶段带 `fill` 指回包着它的留白；内层留白自己也带（嵌套关系只在这里）。
    const fills = new Map((flow?.phases ?? []).map((phase) => [phase.name, phase.fill]));
    assert.equal(fills.get("outer"), undefined);
    assert.equal(fills.get("inner"), "hole#a20bc574");
    assert.equal(fills.get("B"), "hole#a20bc574");
  });
});

describe("collectSitePhases", () => {
  it("stamps issue and actor events with their lexical birth phase", () => {
    const { core } = analyzed(
      'phase("摸底");\nconst a = agent("worker");\nconst r = await a.ask("go");\nphase("执行");\nreturn r;',
    );
    assert.ok(core);
    const table = collectSitePhases(core);
    assert.equal(table.get("actor#1"), "摸底");
    assert.equal(table.get("ask#1"), "摸底");
  });

  it("stamps an open hole as a step in the phase it stands in", () => {
    const { core } = analyzed(OPEN_SCRIPT);
    assert.ok(core);
    assert.equal(collectSitePhases(core).get("hole#21b40fca"), "摸底");
  });

  it("leaves a helper called from two phases out of the table", () => {
    const script = [
      'function spawn() { return agent("worker"); }',
      'phase("A");',
      'const a = spawn();',
      'await a.ask("one");',
      'phase("B");',
      'const b = spawn();',
      'await b.ask("two");',
      "return 1;",
    ].join("\n");
    const { core } = analyzed(script);
    assert.ok(core);
    const table = collectSitePhases(core);
    // actor#1 从两个阶段到达 → 不是唯一出生阶段，不进表（引擎退回动态当前阶段）。
    assert.equal(table.get("actor#1"), undefined);
  });
});
