import { describe, expect, it } from "vitest";
import {
  extractAssistantDirectives,
  findAssistantDirectivePrefixStart,
  findMarkdownCodeRanges,
  findUnclosedAssistantDirectiveStart,
  overlapsAssistantTextRanges,
  type AssistantTextRange,
} from "@/lib/assistantDirectiveParser.js";
import { projectAssistantCodeComments } from "@/lib/assistantCodeComment.js";
import { projectZCodeFileCitations } from "@/lib/zcodeFileCitation.js";

/**
 * Regression: streaming directive prefix probe backward-scan window.
 *
 * Rationale lives in docs/specs/performance-rescan-ui-directive-prefix-scan.md: the
 * pre-change implementation rescanned the whole text backwards character by character,
 * slicing the remaining text at every colon and running several startsWith checks per
 * directive name, so the cumulative slice range grows quadratically with text length.
 * Streaming callers recompute whenever the body text changes.
 *
 * This file freezes the pre-change implementation as an oracle (never shipped) and
 * differentially compares it against the production function, plus a workload budget
 * counted with the same prototype-instrumentation convention used by
 * packages/ui/test/performanceFileTreeSearchExpansion.test.ts.
 */

interface PrefixOptions {
  minimumSingleColonPrefixLength?: number;
  singleColonDirectiveNames?: readonly string[];
  tripleColonDirectiveNames?: readonly string[];
}

/** Line-for-line equivalent of the pre-change algorithm; comparison baseline only. */
function referenceDirectivePrefixStart(
  content: string,
  directiveNames: readonly string[],
  protectedRanges: readonly AssistantTextRange[] = [],
  options: PrefixOptions = {},
): number | null {
  const singleColonNames = new Set(options.singleColonDirectiveNames ?? []);
  const tripleColonNames = new Set(options.tripleColonDirectiveNames ?? []);
  const minimumSingleColonPrefixLength = options.minimumSingleColonPrefixLength ?? 2;
  const overlaps = (start: number, end: number, ranges: readonly AssistantTextRange[]): boolean =>
    ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);

  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index] !== ":") continue;
    if (content[index - 1] === ":") continue;
    if (overlaps(index, index + 1, protectedRanges)) continue;

    const suffix = content.slice(index);
    const isPrefix = directiveNames.some((directiveName) => {
      const canonicalName = `::${directiveName}`;
      const tripleColonName = `:::${directiveName}`;
      if (
        tripleColonNames.has(directiveName) &&
        suffix.startsWith(":::") &&
        (tripleColonName.startsWith(suffix) ||
          (suffix.startsWith(tripleColonName) &&
            /^\s*$/.test(suffix.slice(tripleColonName.length))))
      ) {
        return true;
      }
      if (
        suffix.startsWith("::") &&
        (canonicalName.startsWith(suffix) ||
          (suffix.startsWith(canonicalName) && /^\s*$/.test(suffix.slice(canonicalName.length))))
      ) {
        return true;
      }

      if (!singleColonNames.has(directiveName) || suffix.length < minimumSingleColonPrefixLength) {
        return false;
      }
      const compatibilityName = `:${directiveName}`;
      if (compatibilityName.startsWith(suffix)) return true;
      return (
        suffix.startsWith(compatibilityName) && /^\s*$/.test(suffix.slice(compatibilityName.length))
      );
    });
    if (isPrefix) return index;
  }
  return null;
}

/** Projection oracle: only the prefix probe is swapped for the frozen old algorithm. */
function referenceProjectZCodeFileCitations(
  content: string,
  options: { streaming: boolean },
): { visibleText: string } {
  if (!options.streaming || !content) return { visibleText: content };
  const protectedRanges = findMarkdownCodeRanges(content);
  const unclosedStart = findUnclosedAssistantDirectiveStart(
    content,
    "zcode-file-citation",
    protectedRanges,
    { allowSingleColon: true, allowSmartQuotes: true, allowTripleColon: true },
  );
  if (unclosedStart === null) {
    const prefixStart = referenceDirectivePrefixStart(
      content,
      ["code-comment", "zcode-file-citation"],
      protectedRanges,
      {
        minimumSingleColonPrefixLength: ":zcode".length,
        singleColonDirectiveNames: ["zcode-file-citation"],
        tripleColonDirectiveNames: ["zcode-file-citation"],
      },
    );
    return prefixStart === null
      ? { visibleText: content }
      : { visibleText: content.slice(0, prefixStart) };
  }
  return { visibleText: content.slice(0, unclosedStart) };
}

const CODE_COMMENT_DIRECTIVE_NAME = "code-comment";

function referenceProjectAssistantCodeComments(
  content: string,
  options: { streaming: boolean },
): { visibleText: string } {
  const protectedRanges = findMarkdownCodeRanges(content);
  const replacements: { end: number; replacement: string; start: number }[] = [];
  for (const directive of extractAssistantDirectives(content, CODE_COMMENT_DIRECTIVE_NAME)) {
    if (
      !directive.parameters ||
      overlapsAssistantTextRanges(directive.start, directive.start + 1, protectedRanges)
    ) {
      continue;
    }
    const title = directive.parameters.title?.trim();
    const body = directive.parameters.body?.trim();
    const file = directive.parameters.file?.trim();
    if (!title || !body || !file) continue;
    const lineStart = content.lastIndexOf("\n", directive.start - 1) + 1;
    const nextNewline = content.indexOf("\n", directive.end);
    const lineEnd = nextNewline < 0 ? content.length : nextNewline;
    const prefix = content.slice(lineStart, directive.start);
    const suffix = content.slice(directive.end, lineEnd);
    replacements.push(
      !prefix.trim() && !suffix.trim()
        ? { start: lineStart, end: nextNewline < 0 ? lineEnd : nextNewline + 1, replacement: "" }
        : { start: directive.start, end: directive.end, replacement: " " },
    );
  }

  if (options.streaming) {
    const unclosedStart = findUnclosedAssistantDirectiveStart(
      content,
      CODE_COMMENT_DIRECTIVE_NAME,
      protectedRanges,
    );
    if (unclosedStart !== null) {
      replacements.push({ start: unclosedStart, end: content.length, replacement: "" });
    } else {
      const prefixStart = referenceDirectivePrefixStart(
        content,
        [CODE_COMMENT_DIRECTIVE_NAME, "zcode-file-citation"],
        protectedRanges,
        {
          minimumSingleColonPrefixLength: ":zcode".length,
          singleColonDirectiveNames: ["zcode-file-citation"],
          tripleColonDirectiveNames: ["zcode-file-citation"],
        },
      );
      if (prefixStart !== null) {
        replacements.push({ start: prefixStart, end: content.length, replacement: "" });
      }
    }
  }

  let visibleText = content;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    visibleText =
      visibleText.slice(0, replacement.start) +
      replacement.replacement +
      visibleText.slice(replacement.end);
  }
  return { visibleText };
}

const PRODUCTION_NAMES = ["code-comment", "zcode-file-citation"];
const PRODUCTION_OPTIONS: PrefixOptions = {
  minimumSingleColonPrefixLength: ":zcode".length,
  singleColonDirectiveNames: ["zcode-file-citation"],
  tripleColonDirectiveNames: ["zcode-file-citation"],
};

const CODE_COMMENT =
  '::code-comment{title="\u68c0\u67e5" body="\u4fdd\u7559\u539f\u6587" file="src/test.ts" start=2}';
const CITATION = '::zcode-file-citation{path="/work/report.pdf"}';

/**
 * Structured boundaries: three colon kinds, single/triple colon allowlists, minimum single
 * colon prefix length, whitespace around names, protected ranges, empty / whitespace /
 * duplicate / empty directive names, Unicode whitespace and long whitespace tails.
 */
const STRUCTURED_CASES: Array<{
  content: string;
  names?: readonly string[];
  options?: PrefixOptions;
  ranges?: AssistantTextRange[];
}> = [
  // empty and whitespace-only input (including Unicode whitespace)
  { content: "" },
  { content: " " },
  { content: "   " },
  { content: "\n\r\n\t " },
  { content: "\uFEFF" },
  { content: "\uFEFF\uFEFF " },
  { content: "\u00a0\u3000\u2028\u2029" },
  { content: "\u000b\u000c" },
  // bare colon runs
  { content: ":" },
  { content: "::" },
  { content: ":::" },
  { content: "::::" },
  { content: ":::::" },
  { content: "::::::" },
  { content: "tail::" },
  { content: "tail:::" },
  { content: "tail:" },
  // double colon and strict prefixes
  { content: "body ::co" },
  { content: "body ::code-comment" },
  { content: "body ::code-commen" },
  { content: "body ::CODE-COMMENT" },
  { content: "body ::zcode-file-citation" },
  { content: "body ::zcode-file-citatio" },
  // complete name followed by whitespace (Unicode whitespace and long tails)
  { content: "body ::code-comment " },
  { content: "body ::code-comment\t\n " },
  { content: "body ::code-comment x" },
  { content: "body ::code-comment\uFEFF" },
  { content: "body ::code-comment\uFEFF\uFEFF" },
  { content: "body ::code-comment\u00a0" },
  { content: "body ::code-comment\u3000" },
  { content: "body ::code-comment\u2028" },
  { content: `::code-comment${" ".repeat(4000)}` },
  { content: `::code-comment ${" ".repeat(4000)}` },
  { content: `::zcode-file-citation${" ".repeat(4000)}` },
  { content: `::zcode-file-citation${"\uFEFF".repeat(2000)}` },
  { content: `${"a".repeat(3000)}::code-comment${" ".repeat(2000)}` },
  // an early colon must not match (text after the name is not whitespace-only)
  { content: `::code-comment ${"z".repeat(3000)}` },
  { content: `::code-comment ${"z".repeat(3000)} ` },
  // triple colon
  { content: "body :::code-comment" },
  { content: "body :::code-comment  " },
  { content: "body :::code-comment x" },
  { content: "body :::code-commen" },
  { content: `:::code-comment${" ".repeat(4000)}` },
  // single colon compatibility
  { content: "body :zcode-file-citation" },
  { content: "body :zcode-file-citation " },
  { content: "body :zcode" },
  { content: "body :zcod" },
  { content: "body :z" },
  {
    content: "body :",
    options: { minimumSingleColonPrefixLength: 1, singleColonDirectiveNames: ["a"] },
  },
  {
    content: "x :zcode-file-citation",
    options: {
      minimumSingleColonPrefixLength: 5,
      singleColonDirectiveNames: ["zcode-file-citation"],
    },
  },
  {
    content: "x :zcode-file-citation",
    options: {
      minimumSingleColonPrefixLength: 99,
      singleColonDirectiveNames: ["zcode-file-citation"],
    },
  },
  { content: "x ::zcode-file-citation", options: { singleColonDirectiveNames: [] } },
  {
    content: "x ::zcode-file-citation",
    options: { singleColonDirectiveNames: ["zcode-file-citation"] },
  },
  // several colon runs and several names: rightmost match wins regardless of name order
  { content: "a::b::c::code-comment" },
  { content: "a:::b:::code-comment" },
  { content: "a::b::zcode-file-citation::code-comment" },
  { content: "x ::zcode-file-citation", names: ["code-comment", "zcode-file-citation"] },
  { content: "x ::zcode-file-citation", names: ["zcode-file-citation", "code-comment"] },
  // empty / whitespace / duplicate / empty directive names, names containing whitespace
  { content: "x ::code-comment", names: [] },
  { content: "x ::code-comment", names: ["code-comment"] },
  { content: "x ::code-comment", names: ["other"] },
  { content: "x ::code-comment", names: ["code-comment", "code-comment"] },
  {
    content: "x ::code-comment",
    names: ["code-comment", "zcode-file-citation", "code-comment"],
  },
  { content: "x ::", names: [""] },
  { content: "x :::", names: [""] },
  { content: "x :: ", names: [""] },
  { content: "x :: ", names: [" "] },
  { content: "x ::  ", names: [" "] },
  { content: "x :: ", names: ["", " "] },
  { content: "x ::a b", names: ["a b"] },
  { content: "x ::a b ", names: ["a b"] },
  { content: "x ::a b", names: ["a b", "a b "] },
  { content: "x ::a b  ", names: ["a b "] },
  { content: `x ::a b${" ".repeat(3000)}`, names: ["a b "] },
  {
    content: "x :::a b  ",
    names: ["a b "],
    options: { tripleColonDirectiveNames: ["a b "] },
  },
  // Unicode body text
  { content: "\uD83D\uDE00 ::co" },
  { content: "\uD83D\uDE00::code-comment\uD83D\uDE00" },
  { content: "\u4e2d\u6587\uff1a\uff1acode-comment" },
  { content: "\u4e2d\u6587:::code-comment" },
  { content: "a\r\n::code-comment\r\n" },
  // protected ranges skip the whole candidate cell
  { content: "::code-comment and later ::code-comment", ranges: [[0, 15]] },
  { content: "::code-comment and later ::code-comment", ranges: [[0, 14]] },
  { content: "prefix `::code-comment` suffix ::code-comment", ranges: [[3, 20]] },
  { content: ":::code-comment fully protected", ranges: [[0, 18]] },
  { content: ":::code-comment fully protected", ranges: [[1, 18]] },
  { content: ":::code-comment fully protected", ranges: [[2, 18]] },
  { content: ":::code-comment fully protected", ranges: [[3, 18]] },
];

/** Colon-dense but prefix-free body text, standing in for a long real answer. */
function colonHeavyContent(size: number): string {
  const unit =
    "The build ran in 3:42 and reported ratio 2:1 for module a:b. See docs at https://example.com/x:y done\n";
  let text = "";
  while (text.length < size) text += unit;
  return text.slice(0, size);
}

function seededDocuments(count: number): string[] {
  let seed = 0x9e3779b9;
  const next = (limit: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const fragments = [
    "body\uD83D\uDE00",
    " ",
    "\t",
    "\n",
    "\r",
    "\uFEFF",
    "\u00a0",
    ":",
    "::",
    ":::",
    "::::",
    "::c",
    "::code-comment",
    "::code-comment ",
    ":::code-comment",
    ":zcode",
    ":zcode-file-citation",
    "::zcode-file-citation",
    "::zcode-file-citation ",
    CODE_COMMENT,
    CITATION,
    "tail",
  ];
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + next(48) }, () => fragments[next(fragments.length)]).join(""),
  );
}

/** Counts slice / startsWith calls and the cumulative slice range inside one call. */
const COUNTED_STRING_METHODS = ["slice", "startsWith"] as const;

function countStringOperations(run: () => void): {
  sliceCalls: number;
  sliceRange: number;
  startsWith: number;
} {
  const prototype = String.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = COUNTED_STRING_METHODS.map((name) => ({ name, original: prototype[name] }));
  const counts = { sliceCalls: 0, sliceRange: 0, startsWith: 0 };
  for (const { name, original } of originals) {
    prototype[name] = function counted(this: string, ...args: unknown[]): unknown {
      if (name === "slice") {
        const result = original.apply(this, args) as string;
        counts.sliceCalls += 1;
        counts.sliceRange += result.length;
        return result;
      }
      counts.startsWith += 1;
      return original.apply(this, args);
    };
  }
  try {
    run();
  } finally {
    for (const { name, original } of originals) {
      prototype[name] = original;
    }
  }
  return counts;
}

describe("streaming directive prefix scan window", () => {
  it("matches the pre-change algorithm on structured boundaries", () => {
    for (const testCase of STRUCTURED_CASES) {
      const names = testCase.names ?? PRODUCTION_NAMES;
      const options = testCase.options ?? PRODUCTION_OPTIONS;
      const ranges = testCase.ranges ?? [];
      const actual = findAssistantDirectivePrefixStart(testCase.content, names, ranges, options);
      const expected = referenceDirectivePrefixStart(testCase.content, names, ranges, options);
      expect(actual, JSON.stringify(testCase.content.slice(0, 60))).toBe(expected);
    }
  });

  it("matches the pre-change algorithm on seeded random documents", () => {
    for (const content of seededDocuments(1200)) {
      const ranges = findMarkdownCodeRanges(content);
      const actual = findAssistantDirectivePrefixStart(
        content,
        PRODUCTION_NAMES,
        ranges,
        PRODUCTION_OPTIONS,
      );
      const expected = referenceDirectivePrefixStart(
        content,
        PRODUCTION_NAMES,
        ranges,
        PRODUCTION_OPTIONS,
      );
      expect(actual, JSON.stringify(content.slice(0, 60))).toBe(expected);
    }
  });

  it("matches the pre-change algorithm on every streaming prefix length", () => {
    const documents = [
      `intro: see ${CODE_COMMENT}\nmore body ::code-comment{title="half`,
      `earlier ${CITATION} body ::zcode-file-citation{path="a`,
      "```md\n" + CODE_COMMENT + "\n" + CITATION + "\n```\n" + CODE_COMMENT + "\n::code-comment",
      colonHeavyContent(1200),
      ":::code-comment   \n\nmore body ::zcode-file-citation  ",
      `${"a".repeat(600)}::code-comment${" ".repeat(300)}`,
    ];
    for (const document of documents) {
      for (let end = 0; end <= document.length; end += 1) {
        const prefix = document.slice(0, end);
        const ranges = findMarkdownCodeRanges(prefix);
        const actual = findAssistantDirectivePrefixStart(
          prefix,
          PRODUCTION_NAMES,
          ranges,
          PRODUCTION_OPTIONS,
        );
        const expected = referenceDirectivePrefixStart(
          prefix,
          PRODUCTION_NAMES,
          ranges,
          PRODUCTION_OPTIONS,
        );
        expect(actual, JSON.stringify(prefix.slice(-24))).toBe(expected);
      }
    }
  });

  it("keeps both streaming projections byte-identical to the pre-change algorithm", () => {
    const documents = [
      "",
      "plain body",
      CODE_COMMENT,
      CITATION,
      `${CODE_COMMENT}\nbody\n${CODE_COMMENT}`,
      `before ${CODE_COMMENT} after`,
      `${CODE_COMMENT}\n::code-comment{title="unfinished`,
      `${CODE_COMMENT}\n::code-comment`,
      `${CODE_COMMENT}\n::zcode-file-cit`,
      "`" + CODE_COMMENT + "`\n" + CODE_COMMENT,
      `<pre>${CODE_COMMENT}</pre>\n${CODE_COMMENT}`,
      `~~~\n${CODE_COMMENT}\n~~~\n::code-comment{title="unfinished`,
      colonHeavyContent(2000) + '\n::zcode-file-citation{path="',
      colonHeavyContent(2000) + "\n::code-comment",
      colonHeavyContent(2000) + "\n::code-comment ",
      colonHeavyContent(2000) + "\n:::zcode-file-citation  ",
    ];
    for (const document of documents) {
      for (const streaming of [false, true]) {
        expect(
          projectZCodeFileCitations(document, { streaming }).visibleText,
          `citations ${streaming} ${JSON.stringify(document.slice(-24))}`,
        ).toBe(referenceProjectZCodeFileCitations(document, { streaming }).visibleText);
        expect(
          projectAssistantCodeComments(document, { streaming }).visibleText,
          `comments ${streaming} ${JSON.stringify(document.slice(-24))}`,
        ).toBe(referenceProjectAssistantCodeComments(document, { streaming }).visibleText);
      }
    }
  });

  it("bounds the backward scan to a window proportional to the longest directive name", () => {
    const maxPrefixLength = 3 + Math.max(...PRODUCTION_NAMES.map((name) => name.length));
    // The window spans at most maxPrefixLength characters, so at most
    // (maxPrefixLength + 1) / 2 colon-run starts, each doing at most 6 startsWith per
    // name; one extra factor of head-room is kept on top.
    const budget = 6 * PRODUCTION_NAMES.length * (maxPrefixLength + 1);
    for (const size of [4000, 16000, 64000]) {
      const content = colonHeavyContent(size);
      const ranges = findMarkdownCodeRanges(content);
      const counts = countStringOperations(() =>
        findAssistantDirectivePrefixStart(content, PRODUCTION_NAMES, ranges, PRODUCTION_OPTIONS),
      );
      expect(
        counts.startsWith,
        `size=${size} startsWith=${counts.startsWith} budget=${budget}`,
      ).toBeLessThanOrEqual(budget);
      expect(
        counts.sliceCalls,
        `size=${size} sliceCalls=${counts.sliceCalls} budget=${budget}`,
      ).toBeLessThanOrEqual(budget);
      // The cumulative slice range must not grow with the body length either.
      expect(
        counts.sliceRange,
        `size=${size} sliceRange=${counts.sliceRange} budget=${budget * maxPrefixLength}`,
      ).toBeLessThanOrEqual(budget * maxPrefixLength);
    }
  });
});
