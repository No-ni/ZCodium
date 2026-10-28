import { describe, expect, it } from "vitest";
import {
  buildConversationTurnNavigatorItems,
  type BuildConversationTurnNavigatorItemsOptions,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationTurnNavigatorCache } from "@/v4/conversationTurnNavigatorCache.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

const options = {
  assistantEmptyPreview: "empty",
  assistantRunningPreview: "running",
  userFallbackPreview: "user",
};

function unit(id: number, text = "answer", read = () => {}) {
  return {
    key: `turn-${id}`,
    turnId: `turn-${id}`,
    timelineOnly: false,
    isRunning: false,
    visibleUserInputs: [{ rowId: id * 3, origin: "realUser", text: `query ${id}` }],
    assistantTextRows: [
      {
        get text() {
          read();
          return text;
        },
      },
    ],
  } as ConversationTurnRenderUnit;
}

// 独立保留优化前流水线，防止缓存和扫描器共同改变产品文字规则。
function referenceItems(
  units: readonly ConversationTurnRenderUnit[],
  o: BuildConversationTurnNavigatorItemsOptions = options,
) {
  const preview = (texts: string[], fallback: string) => {
    const paragraphs = texts
      .join("\n\n")
      .trim()
      .split(/\n\s*\n/u)
      .map((p) => p.replace(/\s+/gu, " ").trim())
      .filter(Boolean)
      .slice(0, Math.max(1, o.maxPreviewParagraphs ?? 2));
    if (!paragraphs.length) return fallback;
    const text = paragraphs.join("\n");
    const limit = Math.max(8, o.maxPreviewChars ?? 220);
    return text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`;
  };
  return units.flatMap((u, unitIndex) => {
    const users = u.visibleUserInputs.filter((r) => r.origin === "realUser");
    if (u.timelineOnly || !users.length) return [];
    const assistantPreview = u.assistantTextRows.length
      ? preview(
          u.assistantTextRows.map((r) => r.text),
          o.assistantEmptyPreview,
        )
      : u.isRunning
        ? o.assistantRunningPreview
        : o.assistantEmptyPreview;
    return users.map((r, queryIndex) => ({
      key: `${u.key}:query:${r.entityId ?? r.rowId}`,
      turnId: u.turnId,
      unitIndex,
      rowId: r.rowId,
      userPreview: preview([r.text], o.userFallbackPreview),
      assistantPreview,
      assistantPreviewKind: u.assistantTextRows.length ? "text" : u.isRunning ? "running" : "empty",
      isRunning: u.isRunning && queryIndex === users.length - 1,
    }));
  });
}

function withTexts(texts: string[]) {
  return { ...unit(1), assistantTextRows: texts.map((text) => ({ text })) as AssistantTextRow[] };
}

function guardedText(text: string, read: () => void): AssistantTextRow {
  return {
    get text() {
      read();
      return text;
    },
  } as AssistantTextRow;
}

/** 只同步拦截本夹具正文的真实字符访问和整串正则处理量，不测耗时。 */
function countTextTouches(text: string, run: () => void) {
  const charCodeAt = String.prototype.charCodeAt;
  const split = String.prototype.split;
  const replace = String.prototype.replace;
  let touches = 0;
  String.prototype.charCodeAt = function (index) {
    if (String(this) === text) touches++;
    return charCodeAt.call(this, index);
  };
  String.prototype.split = function (...args: Parameters<typeof split>) {
    if (String(this) === text) touches += text.length;
    return split.apply(this, args);
  };
  String.prototype.replace = function (...args: Parameters<typeof replace>) {
    if (String(this) === text) touches += text.length;
    return replace.apply(this, args);
  };
  try {
    run();
    return touches;
  } finally {
    String.prototype.charCodeAt = charCodeAt;
    String.prototype.split = split;
    String.prototype.replace = replace;
  }
}

describe("navigator bounded body work", () => {
  it("matches original text, whitespace, fences and numeric option semantics", () => {
    const cases = [
      [],
      [""],
      [" \t\n"],
      ["a\n\nb"],
      ["a\n \nb"],
      ["a\r\n\r\nb"],
      ["a\rb\u2028c\u2029d"],
      ["\ufeff\u00a0 a\t b \u3000"],
      ["a\n", "b"],
      ["", " a ", "\n \n", " b ", ""],
      ["中文🙂\t🚀\n\n尾部"],
      ["```ts\nlet a = 1;\n\n```\n\n尾部"],
      ["12345678   "],
      ["12345678   x"],
      ["12345678\n\nx"],
      ["a\u0085\u180e\u200b\u2060b"],
      ["abcde🙂🚀中文longer suffix"],
    ];
    for (const texts of cases) {
      for (const maxPreviewChars of [8, 9, 12, 220, -1, 8.5, NaN, Infinity, -Infinity]) {
        for (const maxPreviewParagraphs of [0, -1, 1, 2, 1.5, NaN, Infinity]) {
          const o = { ...options, maxPreviewChars, maxPreviewParagraphs };
          const u = withTexts(texts);
          expect(buildConversationTurnNavigatorItems([u], o)).toEqual(referenceItems([u], o));
        }
      }
    }
    let seed = 42;
    const tokens = [
      "a",
      "中文",
      "🙂",
      "\n",
      "\r",
      " ",
      "\t",
      "\u00a0",
      "\ufeff",
      "\u2028",
      "\u200b",
      "`",
      "<",
    ];
    for (let sample = 0; sample < 250; sample++) {
      const texts = Array.from({ length: 4 }, () =>
        Array.from({ length: 35 }, () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return tokens[seed % tokens.length];
        }).join(""),
      );
      const o = {
        ...options,
        maxPreviewChars: [8, 17, 40, NaN, Infinity][sample % 5],
        maxPreviewParagraphs: [0, 1, 2, 1.5, NaN, Infinity][sample % 6],
      };
      const u = withTexts(texts);
      expect(buildConversationTurnNavigatorItems([u], o)).toEqual(referenceItems([u], o));
    }
  });

  it("reads at most the decisive ordinary-text prefix, regardless of body length", () => {
    for (const size of [10_000, 1_000_000]) {
      const text = "a".repeat(size);
      const u = withTexts([text]);
      const expected = referenceItems([u]);
      const touches = countTextTouches(text, () => {
        expect(buildConversationTurnNavigatorItems([u], options)).toEqual(expected);
      });
      expect(touches).toBeGreaterThan(0);
      expect(touches).toBeLessThanOrEqual(221);
    }
  });

  it.each(["a".repeat(10000), "first\n\nsecond\n\nthird"])(
    "does not read later assistant sources after the preview is determined",
    (text) => {
      const u = withTexts([text]);
      const expected = referenceItems([u]);
      u.assistantTextRows.push(
        guardedText("unused", () => {
          throw new Error("unnecessary body read");
        }),
      );
      expect(buildConversationTurnNavigatorItems([u], options)).toEqual(expected);
    },
  );

  it("reuses immutable body prefixes across rebuilt units, clocks and irrelevant suffixes", () => {
    const cache = new ConversationTurnNavigatorCache();
    let reads = 0;
    const prefix = guardedText("a".repeat(10000), () => reads++);
    const original = withTexts([]);
    original.assistantTextRows = [prefix];
    Object.defineProperty(original.visibleUserInputs[0]!, "text", {
      get: () => {
        reads++;
        return "question";
      },
    });
    const first = buildConversationTurnNavigatorItems([original], options, cache);
    expect(reads).toBe(2);
    let indexTouches = 0;
    const rows = new Proxy(
      [
        prefix,
        ...Array.from({ length: 10000 }, () =>
          guardedText("unused", () => {
            throw new Error("suffix read");
          }),
        ),
      ],
      {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) indexTouches++;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    for (let tick = 0; tick < 5; tick++) {
      const next = {
        ...original,
        assistantTextRows: rows,
        isRunning: tick % 2 === 0,
        startedAt: tick * 1000,
      };
      expect(buildConversationTurnNavigatorItems([next], options, cache)).toEqual(
        first.map((item) => ({ ...item, isRunning: next.isRunning })),
      );
    }
    expect(reads).toBe(2);
    expect(indexTouches).toBeLessThanOrEqual(15);
  });

  it("invalidates consumed replacements, exhausted appends, options, positions and states", () => {
    const cache = new ConversationTurnNavigatorCache();
    const a = withTexts(["first paragraph", "second"]);
    const b = withTexts(["first paragraph", "replacement"]);
    b.assistantTextRows[0] = a.assistantTextRows[0]!;
    const variants = [
      { units: [a], o: options },
      {
        units: [
          {
            ...a,
            assistantTextRows: [...a.assistantTextRows, { text: "third" } as AssistantTextRow],
          },
        ],
        o: { ...options, maxPreviewParagraphs: 3 },
      },
      { units: [b], o: options },
      { units: [{ ...a, assistantTextRows: [...a.assistantTextRows].reverse() }], o: options },
      { units: [withTexts([])], o: options },
      {
        units: [{ ...withTexts([]), isRunning: true }],
        o: { ...options, assistantRunningPreview: "运行" },
      },
      { units: [withTexts(["   "])], o: { ...options, assistantEmptyPreview: "空" } },
      { units: [unit(0), a], o: options },
      { units: [a], o: options },
      { units: [unit(1, "same-ID new session")], o: options },
    ];
    for (const variant of variants)
      expect(buildConversationTurnNavigatorItems(variant.units, variant.o, cache)).toEqual(
        referenceItems(variant.units, variant.o),
      );
    const complete = withTexts(["a"]);
    buildConversationTurnNavigatorItems([complete], options, cache);
    const appended = {
      ...complete,
      assistantTextRows: [...complete.assistantTextRows, { text: "b" } as AssistantTextRow],
    };
    expect(buildConversationTurnNavigatorItems([appended], options, cache)).toEqual(
      referenceItems([appended]),
    );
    for (const maxPreviewChars of [8, 8.5, NaN, Infinity]) {
      const o = { ...options, maxPreviewChars };
      expect(buildConversationTurnNavigatorItems([a], o, cache)).toEqual(referenceItems([a], o));
    }
  });

  it("keeps query, blank text, fallback, filtering and instance isolation semantics", () => {
    const cache = new ConversationTurnNavigatorCache();
    const u = { ...withTexts(["   "]), isRunning: true };
    u.visibleUserInputs = [
      { ...u.visibleUserInputs[0]!, text: "", entityId: "query" },
      { ...u.visibleUserInputs[0]!, rowId: 5, text: "guide", guided: true },
      { ...u.visibleUserInputs[0]!, rowId: 6, origin: "synthetic" },
    ];
    for (const row of [...u.visibleUserInputs, ...u.assistantTextRows]) Object.freeze(row);
    Object.freeze(u);
    const expected = referenceItems([u]);
    expect(buildConversationTurnNavigatorItems([u], options, cache)).toEqual(expected);
    expect(expected.map((i) => i.isRunning)).toEqual([false, true]);
    expect(expected[0]).toMatchObject({
      userPreview: "user",
      assistantPreview: "empty",
      assistantPreviewKind: "text",
    });
    expect(
      buildConversationTurnNavigatorItems([{ ...u, timelineOnly: true }], options, cache),
    ).toEqual([]);
    expect(
      buildConversationTurnNavigatorItems([u], { ...options, userFallbackPreview: "问题" }, cache),
    ).toEqual(referenceItems([u], { ...options, userFallbackPreview: "问题" }));
    let reads = 0;
    const fresh = { ...unit(9), assistantTextRows: [guardedText("body", () => reads++)] };
    buildConversationTurnNavigatorItems([fresh], options, cache);
    buildConversationTurnNavigatorItems([fresh], options, new ConversationTurnNavigatorCache());
    expect(reads).toBe(2);
  });
});

describe("conversation navigator summary reuse", () => {
  it("does not reread history text when only the streaming tail changes", () => {
    let reads = 0;
    const history = Array.from({ length: 1000 }, (_, i) =>
      unit(i, "history ".repeat(200), () => reads++),
    );
    const cache = new ConversationTurnNavigatorCache();
    const first = buildConversationTurnNavigatorItems(
      [...history, unit(1001, "a")],
      options,
      cache,
    );
    expect(reads).toBe(1000);
    const changed = buildConversationTurnNavigatorItems(
      [...history, unit(1001, "ab")],
      options,
      cache,
    );
    expect(reads).toBe(1000);
    expect(changed[0]).toBe(first[0]);
    expect(changed.at(-1)?.assistantPreview).toBe("ab");
    expect(changed).toEqual(
      buildConversationTurnNavigatorItems([...history, unit(1001, "ab")], options),
    );
  });

  it("invalidates locale, preview limits, positions and same-ID replacement", () => {
    const cache = new ConversationTurnNavigatorCache();
    const old = unit(1, "first paragraph\n\nsecond paragraph");
    const blank = unit(2, "");
    const variants = [
      { units: [old, blank], options },
      { units: [old, blank], options: { ...options, assistantEmptyPreview: "空白" } },
      {
        units: [old, blank],
        options: { ...options, maxPreviewChars: 10, maxPreviewParagraphs: 1 },
      },
      { units: [unit(0), old, blank], options },
      { units: [old], options },
      { units: [unit(1, "another session")], options },
    ];
    for (const variant of variants) {
      expect(buildConversationTurnNavigatorItems(variant.units, variant.options, cache)).toEqual(
        buildConversationTurnNavigatorItems(variant.units, variant.options),
      );
    }
  });
});
