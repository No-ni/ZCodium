import { addOcc, addPlaceholder, clearExact, collapseInto, emptyValue, mergeInto, VALUE_DEPTH_CAP, type AbstractValue } from "./domain.js";


/** The callee's return summary with this call's actual arguments substituted in. */
export function substitute(
  summary: AbstractValue,
  fnId: number,
  argVals: AbstractValue[],
  clear: boolean,
  depth = 0,
): AbstractValue {
  const out = emptyValue();
  for (const occ of summary.occs.values()) {
    addOcc(out, { exact: clear ? false : occ.exact, port: occ.port, site: occ.site });
  }
  for (const ph of summary.phs.values()) {
    if (ph.fnId !== fnId) {
      addPlaceholder(out, ph); // a placeholder of an enclosing function — carry it through
      continue;
    }
    if (ph.rest === true) {
      // A rest formal gathers every actual at index >= ph.param.
      for (let i = ph.param; i < argVals.length; i += 1) {
        const restActual = argVals[i];
        if (restActual !== undefined) mergeInto(out, clear ? clearExact(restActual) : restActual);
      }
      continue;
    }
    const actual = argVals[ph.param];
    if (actual !== undefined) mergeInto(out, clear ? clearExact(actual) : actual);
  }
  for (const fn of summary.fns) out.fns.add(fn);
  // Depth-bounded like the domain merges: beyond the cap, fold nested summary structure
  // into occurrences rather than recursing (keeps this walk finite for deep summaries).
  if (depth >= VALUE_DEPTH_CAP) {
    for (const field of summary.fields.values()) collapseInto(out, field);
    for (const el of summary.bound ?? []) collapseInto(out, el);
    return out;
  }
  // A returned bound function (`function mk(x){ return f.bind(null, x); }`) carries its
  // prefix through the summary; substitute the callee's placeholders inside each prefix arg
  // so `mk(secret)` yields a value whose prefix is `secret`.
  if (summary.bound !== undefined) {
    out.bound = summary.bound.map((el) => substitute(el, fnId, argVals, clear, depth + 1));
  }
  for (const [key, field] of summary.fields)
    out.fields.set(key, substitute(field, fnId, argVals, clear, depth + 1));
  return out;
}
