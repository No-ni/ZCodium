import { describe, expect, it } from "vitest";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import type { MentionItem } from "@/mentions/mentionTypes.js";

type FilterOptions = Parameters<typeof filterMentionItemsWithOptions>[2];

function item(id: string, fields: Partial<MentionItem> = {}): MentionItem {
  return {
    id,
    category: "plugins",
    label: id,
    description: "",
    value: id,
    markdown: id,
    ...fields,
  };
}

function legacyDefaultItems(items: MentionItem[], options: FilterOptions = {}): MentionItem[] {
  if (options.requireQuery) return [];
  const sorted = items
    .map((entry, index) => ({
      entry,
      index,
      priority: entry.category === "files" && entry.data?.kind === "directory" ? 1 : 0,
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ entry }) => entry);
  const limit = options.limit ?? 1000;
  return Number.isFinite(limit) ? sorted.slice(0, Math.max(0, Math.trunc(limit))) : sorted;
}

describe("empty mention query bounded work", () => {
  it("stops reading once the ordinary candidate limit is filled", () => {
    let categoryReads = 0;
    const items = Array.from({ length: 20_000 }, (_, index) => {
      const entry = item(`plugin-${index}`);
      Object.defineProperty(entry, "category", {
        get() {
          categoryReads++;
          return "plugins";
        },
      });
      return entry;
    });
    const expected = legacyDefaultItems(items);
    expect(categoryReads).toBe(20_000);
    categoryReads = 0;
    const actual = filterMentionItemsWithOptions(items, " \n ");
    expect(categoryReads).toBe(1000);
    expect(actual).toHaveLength(1000);
    actual.forEach((entry, index) => expect(entry).toBe(expected[index]));
  });

  it("preserves the stable two-priority order and all limit semantics", () => {
    const directory = item("directory", { category: "files", data: { kind: "directory" } });
    const file = item("file", { category: "files", data: { kind: "file" } });
    const ordinaryWithDirectoryData = item("ordinary-dir-data", { data: { kind: "directory" } });
    const plainFile = item("plain-file", { category: "files" });
    const skill = item("skill", { category: "skills" });
    const inputs = [
      [],
      [directory],
      [directory, directory, file, ordinaryWithDirectoryData, plainFile, skill, directory],
      [file, directory, skill, directory],
      Array.from({ length: 2400 }, (_, index) =>
        index % 3 === 0 ? directory : index % 3 === 1 ? skill : file,
      ),
      [...Array<MentionItem>(1600).fill(directory), ...Array<MentionItem>(1001).fill(skill)],
    ];
    const limits = [undefined, -20, -0.5, 0, 0.9, 1, 2.9, 1000, 2500, NaN, Infinity, -Infinity];
    for (const items of inputs) {
      items.forEach(Object.freeze);
      Object.freeze(items);
      for (const limit of limits) {
        const actual = filterMentionItemsWithOptions(items, " ", { limit });
        const expected = legacyDefaultItems(items, { limit });
        expect(actual).toHaveLength(expected.length);
        expect(actual).not.toBe(items);
        actual.forEach((entry, index) => expect(entry).toBe(expected[index]));
      }
    }
  });

  it("does not read candidates for zero, negative or required empty queries", () => {
    const unreadable = item("unreadable");
    Object.defineProperty(unreadable, "category", {
      get() {
        throw new Error("candidate should not be read");
      },
    });
    for (const limit of [0, -1, 0.9]) {
      expect(filterMentionItemsWithOptions([unreadable], "", { limit })).toEqual([]);
    }
    expect(filterMentionItemsWithOptions([unreadable], " ", { requireQuery: true })).toEqual([]);
  });

  it("keeps nonempty query scoring and Chinese and plugin description boundaries", () => {
    const items = [
      item("substring", { label: "x alpha" }),
      item("prefix", { label: "alpha" }),
      item("sequence", { label: "a_l_p_h_a" }),
      item("plugin-description", { description: "alpha" }),
      item("skill-description", { category: "skills", description: "alpha" }),
      item("keyword", { keywords: ["alpha"] }),
      item("chinese", { label: "浏览器操作" }),
    ];
    expect(filterMentionItemsWithOptions(items, " alpha ").map((entry) => entry.id)).toEqual([
      "prefix",
      "skill-description",
      "substring",
      "sequence",
      "keyword",
    ]);
    expect(filterMentionItemsWithOptions(items, "浏览").map((entry) => entry.id)).toEqual([
      "chinese",
    ]);
    expect(filterMentionItemsWithOptions(items, "浏器")).toEqual([]);
    expect(filterMentionItemsWithOptions(items, "alpha", { limit: 1 })).toEqual([items[1]]);
  });
});
