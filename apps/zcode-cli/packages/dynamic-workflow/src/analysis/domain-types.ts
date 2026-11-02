import type ts from "typescript";
import type { ScriptLoc } from "../compiler/compile.js";


/**
 * The abstract domain of the taint pass and the pure algebra over it. See taint.ts
 * for the analysis that drives these values to a fixpoint.
 *
 * An {@link AbstractValue} carries three orthogonal facts about a runtime value:
 *  - `occs`: the taint labels (artifact/actor site ids) that may have flowed into it,
 *    plus symbolic parameter {@link Placeholder}s when we are inside a function body;
 *  - `fields`: statically-known members (object-literal props, array/tuple indices),
 *    so `x.f` and `[a, b]` stay field-sensitive;
 *  - `fns`: script-local functions reachable as this value, keeping the call graph
 *    total under higher-order code.
 *
 * Every merge is a weak (join-only) union — the analysis is gen-only, so values only
 * ever grow, which is what drives the monotone fixpoint to convergence.
 */

/** A taint occurrence: a site/actor label with an exactness bit and optional join port. */
export interface TaintOcc {
  site: string;
  exact: boolean;
  port?: number;
}


/** Symbolic taint of a function parameter, used to express context-sensitive summaries. */
export interface Placeholder {
  fnId: number;
  param: number;
  /**
   * A rest parameter (`...parts`) is a single formal that gathers every actual at
   * index >= `param`. Resolution (substitute in calls.ts, emission in state.ts)
   * unions ALL those actuals into the formal rather than the single positional one.
   */
  rest?: boolean;
}


export interface AbstractValue {
  /** Keyed by `${site}|${port ?? ""}`. */
  occs: Map<string, TaintOcc>;
  /** Keyed by `${fnId}:${param}`. */
  phs: Map<string, Placeholder>;
  fields: Map<string, AbstractValue>;
  fns: Set<ts.Node>;
  /**
   * A partial-application prefix from `Function.prototype.bind`: `f.bind(null, a)` yields
   * a value carrying f in `fns` plus `bound = [a]`. At the eventual call the prefix is
   * PREPENDED to the actuals (`applyToFns`), so `g()` reaches f's param 0 as `a`. Rebinding
   * composes (earlier bind's args first). Because `fns` is a set, a merged bound/plain
   * value (`flag ? f : f.bind(null, a)`) can't say which fn is bound, so application unions
   * BOTH alignments (with and without the prefix) — sound either way. Undefined for the
   * overwhelmingly common non-bound value (kept off the hot path).
   */
  bound?: AbstractValue[];
  /**
   * MAY-ALIAS back-references: live places a WRITE through this value must ALSO weakly
   * reach, because at runtime this value may BE one of them. Set for a conditional binding
   * (`const a = flag ? box1 : box2` → a's value may-aliases box1 AND box2) and for a
   * `Promise.all` result element that aliases its (place) input. Consulted ONLY at the
   * write primitives ({@link replayMayAliasWrite} in writeField / handleHeapMutator): the
   * write is replayed into each target INEXACTLY (it happens on one arm only — never a
   * strong update), recursing into each target's OWN mayAlias (chained aliases). A Set so
   * unions dedup by slot IDENTITY (loop-carried merges stay finite → the fixpoint
   * terminates). Undefined for the overwhelmingly common non-aliased value.
   *
   * That termination argument has a PREMISE — the **canonical-heap invariant**: every
   * target is drawn from the pass-stable heap, i.e. values keyed by a static program point
   * and created once for the whole fixpoint (env slots per symbol, class instances per
   * class, join results per join call, conditional places per ternary node, and the
   * persistent fields of any of those). A per-pass temporary must NEVER become a target:
   * identity dedup cannot recognize it, so each pass would add one more member, `changed`
   * would stay true forever, and the analysis would hit `ITERATION_CAP` instead of
   * converging (state.ts `joinResultOf` / `condPlaceOf` record the two repros that did).
   */
  mayAlias?: Set<AbstractValue>;
}


/** The edge-bearing facts consumed by graph assembly. Fan-out ids are provisional. */
export interface TaintFacts {
  /** Artifact occurrences reaching each ask instruction (data in-edges to the ask). */
  askData: Map<string, TaintOcc[]>;
  /** Actor occurrences of each ask receiver (drive the context relation). */
  askActor: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each world-read argument. */
  worldReadData: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each open hole's prompt. */
  holeData: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each join, carrying the join input port. */
  joinIn: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each promoted fan-out (provisional id). */
  fanoutIn: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching the script's return expression(s). */
  returnData: TaintOcc[];
  /** Promoted iteration candidates, in source order; `id` is provisional (`fan-out@N`). */
  promoted: PromotedFanout[];
}


export interface PromotedFanout {
  order: number;
  id: string;
  loc: ScriptLoc;
  label: string;
}
