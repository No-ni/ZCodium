import {
  addOcc,
  emptyValue,
  mergeInto,
  phKey,
  type AbstractValue,
  type Placeholder,
} from "./domain.js";

// 发射前的纯展开；实际参数表仍只由 TaintState 持有。
/** Expand parameter placeholders to the union of actual arguments across all calls. */
export function resolvePlaceholders(
  value: AbstractValue,
  actuals: ReadonlyMap<string, AbstractValue>,
  visiting = new Set<string>(),
  seen = new Set<AbstractValue>(),
): AbstractValue {
  if (seen.has(value)) return emptyValue(); // cycle-safe: a shared field contributes once
  seen.add(value);
  const out = emptyValue();
  for (const occ of value.occs.values()) addOcc(out, occ);
  for (const ph of value.phs.values()) resolvePlaceholder(out, ph, actuals, visiting);
  for (const [key, field] of value.fields)
    out.fields.set(key, resolvePlaceholders(field, actuals, visiting, seen));
  // A bound function reaching an emission point (e.g. a returned bound function) must not
  // drop its prefix's taint; fold each resolved prefix arg in (collapsed at emission).
  for (const el of value.bound ?? [])
    mergeInto(out, resolvePlaceholders(el, actuals, visiting, seen));
  return out;
}

function resolvePlaceholder(
  out: AbstractValue,
  ph: Placeholder,
  actuals: ReadonlyMap<string, AbstractValue>,
  visiting: Set<string>,
): void {
  if (ph.rest === true) {
    // A rest formal gathers every actual recorded at index >= ph.param (calls
    // record actuals positionally, so a rest param has many keyed slots).
    for (const [key, actual] of actuals) {
      const sep = key.indexOf(":");
      if (Number(key.slice(0, sep)) !== ph.fnId || Number(key.slice(sep + 1)) < ph.param) continue;
      if (visiting.has(key)) continue;
      visiting.add(key);
      mergeInto(out, resolvePlaceholders(actual, actuals, visiting));
      visiting.delete(key);
    }
    return;
  }
  const key = phKey(ph);
  if (visiting.has(key)) return; // recursion → bottom
  const actual = actuals.get(key);
  if (actual === undefined) return;
  visiting.add(key);
  mergeInto(out, resolvePlaceholders(actual, actuals, visiting));
  visiting.delete(key);
}
