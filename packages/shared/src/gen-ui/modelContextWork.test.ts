import { describe, expect, it, vi } from "vitest";
import {
  buildGenUiModelContext,
  GEN_UI_CONTEXT_MAX_BYTES,
  GEN_UI_STATE_MAX_ENTRIES,
  genUiWidgetStateSchema,
  type GenUiStateEntry,
} from "./contract.js";

function referenceContext(entries: readonly GenUiStateEntry[]): string {
  const selected: Array<{ path: string; state: unknown }> = [];
  for (const entry of [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, GEN_UI_STATE_MAX_ENTRIES)) {
    const parsed = genUiWidgetStateSchema.safeParse(entry.state);
    if (!parsed.success || parsed.data.modelContent === null) continue;
    const next = { path: entry.path, state: parsed.data.modelContent };
    if (
      new TextEncoder().encode(JSON.stringify([...selected, next])).length >
      GEN_UI_CONTEXT_MAX_BYTES
    )
      break;
    selected.push(next);
  }
  return selected.length
    ? `<untrusted_gen_ui_state>\n${JSON.stringify(selected).replaceAll("<", "\\u003c")}\n</untrusted_gen_ui_state>`
    : "";
}

function entry(
  path: string,
  modelContent: unknown,
  privateContent: unknown = null,
): GenUiStateEntry {
  return { path, state: { modelContent, privateContent } };
}

function payload(context: string): Array<{ path: string; state: unknown }> {
  return context ? JSON.parse(context.split("\n")[1]!) : [];
}

function boundaryEntries(): GenUiStateEntry[] {
  const entries = Array.from({ length: 4 }, (_, i) =>
    entry(`/project/${i}.html`, "x".repeat(15_000)),
  );
  entries.push(entry("/project/4.html", ""));
  const json = JSON.stringify(
    entries.map(({ path, state }) => ({ path, state: state.modelContent })),
  );
  entries[4]!.state.modelContent = "x".repeat(
    GEN_UI_CONTEXT_MAX_BYTES - new TextEncoder().encode(json).length,
  );
  return entries;
}

describe("Gen UI model context work", () => {
  it("preserves exact UTF-8 boundaries and stops at the first oversized entry", () => {
    const entries = boundaryEntries();
    const exact = buildGenUiModelContext(entries);
    expect(new TextEncoder().encode(exact.split("\n")[1]!).length).toBe(GEN_UI_CONTEXT_MAX_BYTES);
    expect(payload(exact)).toHaveLength(5);
    expect(exact).toBe(referenceContext(entries));

    entries[4]!.state.modelContent += "x";
    entries.push(entry("/project/5.html", 0));
    const oversized = buildGenUiModelContext(entries);
    expect(payload(oversized)).toHaveLength(4);
    expect(oversized).toBe(referenceContext(entries));
  });

  it("accounts for Unicode and escapes delimiters only after applying the original budget", () => {
    const entries = boundaryEntries();
    const length = (entries[4]!.state.modelContent as string).length;
    entries[4]!.state.modelContent = `中😀${"x".repeat(length - 7)}`;
    expect(new TextEncoder().encode(buildGenUiModelContext(entries).split("\n")[1]!).length).toBe(
      GEN_UI_CONTEXT_MAX_BYTES,
    );
    entries[4]!.state.modelContent += "中";
    expect(payload(buildGenUiModelContext(entries))).toHaveLength(4);

    const escaped = boundaryEntries();
    escaped[4]!.state.modelContent = "<".repeat(length);
    const text = buildGenUiModelContext(escaped);
    expect(payload(text)).toHaveLength(5);
    expect(new TextEncoder().encode(text.split("\n")[1]!).length).toBeGreaterThan(
      GEN_UI_CONTEXT_MAX_BYTES,
    );
    expect(text).toBe(referenceContext(escaped));
    expect(buildGenUiModelContext([entry("/project/lone.html", "\ud800")])).toBe(
      referenceContext([entry("/project/lone.html", "\ud800")]),
    );
  });

  it("retains stable sorting, the pre-filter entry cap, and complete state validation", () => {
    const entries = Array.from({ length: 101 }, (_, i) =>
      entry(`/project/${String(i).padStart(3, "0")}.html`, i === 100 ? "excluded" : null),
    ).reverse();
    expect(buildGenUiModelContext(entries)).toBe("");
    const mixed = [
      entry("/project/same.html", false),
      entry("/project/same.html", 0),
      entry("/project/same.html", ""),
      entry("/project/invalid.html", "invalid", Infinity),
      entry("/project/oversized.html", "invalid", "x".repeat(16_384)),
      entry("/project/private.html", "public", "private-marker"),
    ];
    const context = buildGenUiModelContext(mixed);
    expect(context).toBe(referenceContext(mixed));
    expect(payload(context).map(({ state }) => state)).toEqual(["public", false, 0, ""]);
    expect(context).not.toContain("private-marker");
    expect(context).not.toContain("invalid");
  });

  it("matches the original algorithm for generated mixed states without mutating inputs", () => {
    let seed = 0x98765432;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    const values = [null, false, 0, "", '中😀<\n\\"', "\ud800", { nested: [1, true, "a"] }];
    for (let sample = 0; sample < 160; sample++) {
      const entries = Array.from({ length: random() % 130 }, () => {
        const value = values[random() % values.length];
        const next = entry(
          `/project/${random() % 40}-中.html`,
          random() % 5 === 0 ? "x中".repeat(random() % 6_000) : value,
          random() % 7 === 0 ? Infinity : { private: sample },
        );
        Object.freeze(next.state);
        return Object.freeze(next);
      });
      Object.freeze(entries);
      expect(buildGenUiModelContext(entries)).toBe(referenceContext(entries));
    }
  });

  it("serializes each output entry once instead of revisiting every selected prefix", () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      entry(`/project/${String(i).padStart(3, "0")}.html`, { value: i }),
    );
    const stringify = JSON.stringify;
    let visits = 0;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
      const isOutputEntry = (item: unknown): boolean =>
        typeof item === "object" && item !== null && "path" in item && "state" in item;
      visits += Array.isArray(value)
        ? value.filter(isOutputEntry).length
        : Number(isOutputEntry(value));
      return stringify(value, ...args);
    });
    let reference: string;
    let actual: string;
    let oldVisits: number;
    let newVisits: number;
    try {
      reference = referenceContext(entries);
      oldVisits = visits;
      visits = 0;
      actual = buildGenUiModelContext(entries);
      newVisits = visits;
    } finally {
      spy.mockRestore();
    }
    expect(actual!).toBe(reference!);
    expect(oldVisits!).toBe(5_150);
    expect(newVisits!).toBe(100);
  });
});
