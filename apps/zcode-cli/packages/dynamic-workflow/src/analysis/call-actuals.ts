import ts from "typescript";
import { clearExact, collapseInto, emptyValue, type AbstractValue } from "./domain.js";
import type { EvalContext, Evaluator } from "./taint.js";

// 从调用分派拆出实参收集，维持行数约束；状态仍由同一 Evaluator 持有。
/**
 * Evaluate an actual-argument list into positional values, their place aliases (for
 * parameter write-back), and an optional inexact TAIL. Positional certainty ends at the
 * first `...spread`: the spread element (and every actual after it) folds into one
 * collapsed, exactness-cleared tail that binds to every parameter at index >= the spread's
 * position — the runtime unpacking length is unknown, so the smear is the sound baseline.
 * `f(...pair)` evaluated the spread as ONE actual at index 0, so params >= 1
 * resolved to nothing (a dropped may-flow: `pair[1]` never reached `f`'s second param).
 */
export function buildActuals(
  ev: Evaluator,
  argsNodes: readonly ts.Expression[],
  ctx: EvalContext,
): {
  explicit: AbstractValue[];
  places: (AbstractValue | undefined)[];
  tail: AbstractValue | undefined;
} {
  const spreadIndex = argsNodes.findIndex((a) => ts.isSpreadElement(a));
  if (spreadIndex < 0) {
    const explicit = argsNodes.map((a) => ev.evalExpr(a, ctx));
    return {
      explicit,
      places: argsNodes.map((a, i) => ev.argWriteBackPlace(a, explicit[i] as AbstractValue)),
      tail: undefined,
    };
  }
  const explicit = argsNodes.slice(0, spreadIndex).map((a) => ev.evalExpr(a, ctx));
  const places = argsNodes
    .slice(0, spreadIndex)
    .map((a, i) => ev.argWriteBackPlace(a, explicit[i] as AbstractValue));
  const tail = emptyValue();
  for (const arg of argsNodes.slice(spreadIndex)) collapseInto(tail, ev.evalExpr(arg, ctx));
  return { explicit, places, tail: clearExact(tail) };
}
