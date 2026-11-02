import ts from "typescript";
import {
  addOcc,
  phKey,
  collapse,
  emptyValue,
  isActorSite,
  type Placeholder,
  type AbstractValue,
  type TaintOcc,
} from "./domain.js";

/** How a function reached a call site: as the thing called, or as an argument a library may invoke. */
export type ApplicationVia = "callee" | "argument";

/** Parameter `param` of the tracked script function `fn`. */
export interface ParamRef {
  fn: ts.Node;
  param: number;
}

/**
 * A parameter named at a site, with the functions the site's merged record owes to it: what
 * the parameter's slot held when the record was made (docs/analysis.md "The call oracle").
 */
export interface ThroughParam extends ParamRef {
  accounted: Set<ts.Node>;
}

/** What an argument binds to the parameter it fills at a callee application. */
export interface ArgBinding {
  /** Every tracked function the argument's value held — the merged answer. */
  fns: Set<ts.Node>;
  /** The argument was itself a parameter of its enclosing function: resolve it there. */
  through: ThroughParam[];
}

/**
 * Emission-time placeholder resolution (docs/analysis.md, "Calls"): a value's parameter
 * placeholders expand to the union of the actuals recorded across ALL calls, recursively
 * through the placeholders those actuals carry, and the whole is collapsed to occurrences.
 *
 * That is reachability over the placeholder graph — one node per `paramActuals` slot, its
 * own occurrences being the collapsed actual, an edge to every placeholder the actual carries
 * at any depth (a rest placeholder points at every slot of its function at index >= its
 * param). Every node of one strongly connected component reaches the same set, so the
 * components are resolved once each, in the reverse topological order Tarjan emits them,
 * and every sink becomes a lookup.
 *
 * 修复原因：发射期曾按「栈上去重、不记忆」逐个展开占位符，等于枚举占位符图里的每一条简单
 * 路径。一个被很多处共用的 callback 包装器（`limited(slots, async () => …)`）让每个调用方的
 * 实参都带上所有调用方的占位符，图成了完全图，路径数是 n! 量级：9 个调用方 19 秒，用户脚本在
 * 4GB 堆上 OOM。结果只是出现集的并（发射处总会 collapse，字段结构不出这里），与经过哪条路径
 * 无关，所以按强连通分量求可达闭包得到的是同一个答案，代价是 O(V+E)。
 */
export function placeholderResolver(
  paramActuals: ReadonlyMap<string, AbstractValue>,
): (value: AbstractValue) => TaintOcc[] {
  const own = new Map<string, AbstractValue>();
  const slotsByFn = new Map<number, Array<{ key: string; param: number }>>();
  for (const [key, actual] of paramActuals) {
    own.set(key, collapse(actual));
    const sep = key.indexOf(":");
    const fnId = Number(key.slice(0, sep));
    let slots = slotsByFn.get(fnId);
    if (slots === undefined) {
      slots = [];
      slotsByFn.set(fnId, slots);
    }
    slots.push({ key, param: Number(key.slice(sep + 1)) });
  }
  const targets = (ph: Placeholder): string[] => {
    if (ph.rest === true) {
      // A rest formal gathers every actual recorded at index >= ph.param.
      return (slotsByFn.get(ph.fnId) ?? []).filter((slot) => slot.param >= ph.param).map((slot) => slot.key);
    }
    const key = phKey(ph);
    return own.has(key) ? [key] : [];
  };

  // Tarjan: `resolved` maps each slot to its component's shared occurrence set.
  const resolved = new Map<string, AbstractValue>();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (key: string): void => {
    const order = index.size;
    index.set(key, order);
    low.set(key, order);
    stack.push(key);
    onStack.add(key);
    for (const ph of (own.get(key) as AbstractValue).phs.values()) {
      for (const next of targets(ph)) {
        if (!index.has(next)) {
          visit(next);
          low.set(key, Math.min(low.get(key) as number, low.get(next) as number));
        } else if (onStack.has(next)) {
          low.set(key, Math.min(low.get(key) as number, index.get(next) as number));
        }
      }
    }
    if (low.get(key) !== order) return;
    // `key` roots a component: pop its members. Every successor outside it is already
    // resolved — Tarjan completes a component only after all components it reaches.
    const members: string[] = [];
    let member: string;
    do {
      member = stack.pop() as string;
      onStack.delete(member);
      members.push(member);
    } while (member !== key);
    const occs = emptyValue();
    for (const m of members) resolved.set(m, occs);
    for (const m of members) {
      const actual = own.get(m) as AbstractValue;
      for (const occ of actual.occs.values()) addOcc(occs, occ);
      for (const ph of actual.phs.values()) {
        for (const next of targets(ph)) {
          const done = resolved.get(next) as AbstractValue;
          if (done === occs) continue;
          for (const occ of done.occs.values()) addOcc(occs, occ);
        }
      }
    }
  };
  for (const key of own.keys()) if (!index.has(key)) visit(key);

  return (value) => {
    const flat = collapse(value);
    const out = emptyValue();
    for (const occ of flat.occs.values()) addOcc(out, occ);
    for (const ph of flat.phs.values()) {
      for (const key of targets(ph)) {
        for (const occ of (resolved.get(key) as AbstractValue).occs.values()) addOcc(out, occ);
      }
    }
    return [...out.occs.values()];
  };
}

/**
 * Split a converged value's occurrences by label kind over the converged `paramActuals`
 * (docs/analysis.md, "Calls"): one placeholder-resolution pass (placeholderResolver),
 * filtered into actor sites vs artifact sites. The placeholder graph stays owned by
 * TaintState; this only wraps its `paramActuals` reference.
 */
export interface TaintResolvers {
  actor: (value: AbstractValue) => TaintOcc[];
  artifact: (value: AbstractValue) => TaintOcc[];
}

/** Build {@link TaintResolvers} over the converged `paramActuals` (moved from TaintState.resolvers). */
export function createTaintResolvers(
  paramActuals: ReadonlyMap<string, AbstractValue>,
): TaintResolvers {
    const resolve = placeholderResolver(paramActuals);
    return {
      actor: (value) => resolve(value).filter((occ) => isActorSite(occ.site)),
      artifact: (value) => resolve(value).filter((occ) => !isActorSite(occ.site)),
    };
}

/** Bare, non-default, non-rest parameter syntax; ownership and reassignment stay in AnalysisState. */
export function parameterSymbolOf(checker: ts.TypeChecker, expr: ts.Node): { sym: ts.Symbol; fn: ts.Node } | undefined {
  if (!ts.isIdentifier(expr)) return undefined;
  const sym = checker.getSymbolAtLocation(expr);
  const decl = sym?.valueDeclaration;
  if (sym === undefined || decl === undefined || !ts.isParameter(decl)) return undefined;
  if (!ts.isIdentifier(decl.name) || decl.initializer !== undefined || decl.dotDotDotToken !== undefined) return undefined;
  return { sym, fn: decl.parent };
}
