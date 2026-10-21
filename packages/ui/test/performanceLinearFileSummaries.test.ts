import { describe, expect, it, vi } from "vitest";
import * as shared from "@zcode/shared";
import * as paths from "@/lib/path.js";
import * as display from "@/lib/fileDisplay.js";
import * as diff from "@/lib/toolDiffPreview.js";
import * as heuristics from "@/ToolCallBlocks/fileSummaryHeuristics.js";
import * as types from "@/ToolCallBlocks/fileSummaryTypes.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/fileSummaries.js";
import {
  freezeLinearInput,
  linearRandom,
  loadLinearBaseline,
  measureLinearHotpath,
} from "./performanceLinearBaseline.js";

const original = (
  await loadLinearBaseline<{
    readRawToolCallFileSummaries: typeof readRawToolCallFileSummaries;
  }>("file-summaries.ts.txt", {
    "@zcode/shared": shared,
    "@/lib/path.js": paths,
    "@/lib/fileDisplay.js": display,
    "@/lib/toolDiffPreview.js": diff,
    "@/ToolCallBlocks/fileSummaryHeuristics.js": heuristics,
    "@/ToolCallBlocks/fileSummaryTypes.js": types,
  })
).readRawToolCallFileSummaries;

function rawDiff(path: string, oldText = "before", newText = "after") {
  return { type: "diff", path, oldText, newText };
}

function assertEquivalent(raw: unknown, source?: types.EditKindSource) {
  freezeLinearInput(raw);
  freezeLinearInput(source);
  expect(readRawToolCallFileSummaries(raw, source)).toEqual(original(raw, source));
}

describe("linear file-summary lookup preserves raw tool semantics", () => {
  it("preserves first diff, source priority, exact path keys and ordering", () => {
    const raw = {
      content: [
        rawDiff("src/first.ts", "first-old", "first-new"),
        rawDiff("src/first.ts", "ignored-old", "ignored-new"),
        rawDiff("C:\\repo\\中文.ts", "before\n中文", "after\n中文"),
        rawDiff("SRC/FIRST.ts"),
        rawDiff("src/first.ts/../other.ts"),
      ],
      changes: {
        "src/first.ts": { type: "delete", oldText: "direct-old" },
        "direct-only.ts": { type: "add", newText: "direct-new" },
      },
      rawInput: {
        changes: {
          "src/first.ts": { type: "add", newText: "input-new" },
          "input-only.ts": { type: "delete", oldText: "deleted" },
        },
      },
      rawOutput: {
        changes: {
          "src/first.ts": { type: "update", oldText: "output-old", newText: "output-new" },
          "output-only.ts": {
            type: "update",
            oldText: "a",
            newText: "b",
            patch: "@@ -1 +1 @@\n-a\n+b",
          },
        },
      },
    };
    assertEquivalent(raw, { toolName: "Edit" });
    const result = readRawToolCallFileSummaries(raw);
    expect(result.map((entry) => entry.path)).toEqual([
      "src/first.ts",
      "C:\\repo\\中文.ts",
      "SRC/FIRST.ts",
      "src/first.ts/../other.ts",
      "direct-only.ts",
      "input-only.ts",
      "output-only.ts",
    ]);
    expect(result[0]).toMatchObject({
      actionLabel: "Edited",
      operationKind: "update",
      changeStat: { added: 1, removed: 1 },
    });
    expect(result[0]?.patch).toContain("+first-new\n-first-old");
    assertEquivalent(raw, { toolName: "Read" });
    expect(readRawToolCallFileSummaries(raw, { toolName: "Read" })).toEqual([]);
  });

  it("preserves malformed input, display priority, fallback and explicit patches", () => {
    for (const raw of [
      null,
      undefined,
      [],
      "text",
      {},
      { content: [null, { type: "diff", path: "a" }, rawDiff(" "), rawDiff("")] },
    ]) {
      assertEquivalent(raw);
      assertEquivalent(raw, {
        toolName: "Write",
        input: { file_path: "src/fallback.ts", content: "content" },
      });
    }
    const fileDisplay = {
      kind: "file_diff",
      filePath: "src/display.ts",
      additions: 2.4,
      deletions: 1.1,
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new", 2] },
      ],
    };
    assertEquivalent({
      display: {
        kind: "file_diffs",
        files: [null, fileDisplay, { ...fileDisplay, additions: 50 }],
      },
      content: [rawDiff("src/ignored.ts")],
    });
    assertEquivalent(null, { toolName: "Edit", output: { display: fileDisplay } });
    assertEquivalent({
      changes: {
        "src/patch.ts": {
          type: "update",
          diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b",
        },
      },
    });
  });

  it("matches original summaries across 160 mixed change-source inputs", () => {
    for (let seed = 1; seed <= 160; seed++) {
      const next = linearRandom(seed);
      const content = Array.from({ length: next(30) }, () => {
        const index = next(20);
        const path = seed % 2 ? `C:\\synthetic\\file-${index}.ts` : `/synthetic/file-${index}.ts`;
        return rawDiff(path, `old-${next(9)}\n中文`, `new-${next(9)}\n😀`);
      });
      const changes = () =>
        Object.fromEntries(
          Array.from({ length: next(12) }, () => [
            seed % 2 ? `C:\\synthetic\\file-${next(25)}.ts` : `/synthetic/file-${next(25)}.ts`,
            {
              type: ["add", "update", "delete", "other"][next(4)],
              oldText: `before-${next(9)}`,
              newText: `after-${next(9)}`,
            },
          ]),
        );
      assertEquivalent({
        content,
        changes: changes(),
        rawInput: { changes: changes() },
        rawOutput: { changes: changes() },
      });
    }
  });

  it("does not repeatedly inspect every diff path for each summary", () => {
    const count = 500;
    const raw = {
      content: Array.from({ length: count }, (_, index) => rawDiff(`file-${index}.ts`)),
    };
    const expected = original(raw);
    const readDiff = types.readStructuredDiffBlock;
    let pathReads = 0;
    const spy = vi.spyOn(types, "readStructuredDiffBlock").mockImplementation((value) => {
      const parsed = readDiff(value);
      return (
        parsed &&
        new Proxy(parsed, {
          get(target, key, receiver) {
            if (key === "path") pathReads++;
            return Reflect.get(target, key, receiver);
          },
        })
      );
    });
    let result: types.RawToolCallFileSummary[];
    try {
      result = readRawToolCallFileSummaries(raw);
    } finally {
      spy.mockRestore();
    }
    expect(result).toEqual(expected);
    expect(pathReads).toBeLessThan(count * 8);
  });

  it("records same-input summary time without timing gates", () => {
    const report = [];
    for (const count of [8, 500, 2000]) {
      const raw = {
        content: Array.from({ length: count }, (_, index) => rawDiff(`file-${index}.ts`)),
      };
      expect(readRawToolCallFileSummaries(raw)).toEqual(original(raw));
      report.push(
        measureLinearHotpath(
          `file summaries ${count} diffs`,
          () => original(raw),
          () => readRawToolCallFileSummaries(raw),
        ),
      );
    }
    console.info("PERFORMANCE_LINEAR", JSON.stringify(report));
  });
});
