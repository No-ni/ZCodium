import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { loadLegacyPreviewBuilder } from "./fixtures/performance-preview-title.reference.js";
import {
  buildAssistantPreviewCardsFromReferences,
  extractAssistantFileReferences,
  type AssistantFileReference,
} from "@/lib/assistantPreviewCards.js";

const original = await loadLegacyPreviewBuilder();
type PreviewOptions = NonNullable<Parameters<typeof buildAssistantPreviewCardsFromReferences>[3]>;
const EMPTY_REFERENCES: readonly AssistantFileReference[] = Object.freeze([]);
const MARKDOWN_LINK_SOURCE = String.raw`\[([^\]\n]*)\]\(([^)\n]+)\)`;

function countedBuild(action: () => ReturnType<typeof buildAssistantPreviewCardsFromReferences>) {
  let scans = 0;
  let matches = 0;
  const matchAll = String.prototype.matchAll;
  const spy = vi.spyOn(String.prototype, "matchAll").mockImplementation(function (
    this: string,
    regexp: RegExp,
  ) {
    const iterator = matchAll.call(this, regexp);
    if (regexp.source !== MARKDOWN_LINK_SOURCE || regexp.flags !== "g") return iterator;
    scans++;
    const next = iterator.next.bind(iterator);
    iterator.next = (...args) => {
      const result = next(...args);
      if (!result.done) matches++;
      return result;
    };
    return iterator;
  });
  try {
    return { cards: action(), scans, matches };
  } finally {
    spy.mockRestore();
  }
}

function assertEquivalent(
  content: string,
  workspacePath = "/synthetic",
  options: PreviewOptions = {},
) {
  const references = Object.freeze(
    extractAssistantFileReferences(content, workspacePath, { homePath: options.homePath }).map(
      (reference) => Object.freeze(reference),
    ),
  );
  const frozenOptions = Object.freeze({
    ...options,
    changedFilePaths: Object.freeze([...(options.changedFilePaths ?? [])]),
  });
  const before = JSON.stringify({ references, options: frozenOptions });
  const expected = original(content, workspacePath, references, frozenOptions);
  const actual = buildAssistantPreviewCardsFromReferences(
    content,
    workspacePath,
    references,
    frozenOptions,
  );
  expect(actual, content).toEqual(expected);
  expect(JSON.stringify({ references, options: frozenOptions })).toBe(before);
  return actual;
}

const namedUrl = "http://localhost:3000/view";

describe("preview title indexing preserves complete original output", () => {
  it("keeps the first valid title after invalid labels and ignores later duplicate href labels", () => {
    const invalidLabels = [
      "",
      "   ",
      "___",
      "***",
      "`code`",
      "<tag>",
      ")bad",
      "123!".repeat(21),
      "https://example.test",
    ];
    const content = [
      ...invalidLabels.map((label) => `[${label}](${namedUrl})`),
      `[  首个   title  ](${namedUrl})`,
      `[Later title](${namedUrl})`,
      namedUrl,
    ].join("\n");
    expect(assertEquivalent(content)).toEqual([
      {
        id: `website:${namedUrl}`,
        type: "website",
        title: "首个 title",
        subtitleId: "chat.previewCards.website",
        url: namedUrl,
      },
    ]);
    expect(assertEquivalent(`[${"x".repeat(80)}](${namedUrl})`)[0]?.title).toBe("x".repeat(80));
    expect(assertEquivalent(`[${"x".repeat(81)}](${namedUrl})`)[0]?.title).toBe("view");
  });

  it("keeps exact href matching, original angle/trailing cleanup, fallback and code-region behavior", () => {
    const cases = [
      `[First]( <${namedUrl}> ) [Second](${namedUrl})`,
      `[Punctuation](${namedUrl},。) ${namedUrl}`,
      `[Upper](HTTP://LOCALHOST:3000/view) [Lower](${namedUrl})`,
      `[Query](${namedUrl}?a=1#top) [Other](${namedUrl}?a=2#top)`,
      `[Encoded](http://localhost:3000/%E4%B8%AD) [Decoded](http://localhost:3000/中)`,
      `[Unicode 中文 😀](${namedUrl})`,
      `[é😀](${namedUrl})`,
      `\`[Example](${namedUrl})\`\n[Actual](${namedUrl})`,
      `~~~md\n[Example](${namedUrl})\n~~~\n[Actual](${namedUrl})`,
      `http://localhost:3000 http://localhost:3000/ ${namedUrl}`,
      "http://localhost:0/view http://localhost:65536/view http://localhost:65535/view",
      `[broken\nlabel](${namedUrl}) [broken](${namedUrl}\n)`,
    ];
    for (const content of cases) assertEquivalent(content);
  });

  it("preserves file-path title priority, HTML suppression, mixed cards, paths and stable newest-first selection", () => {
    const content = [
      "[HTML](site/index.html)",
      "[Not the title](http://localhost:3000/site/index.html)",
      "[Report](docs/report.md)",
      "[PDF](report.pdf) [Slides](slides.pptx)",
      "[Other preview](http://localhost:3000/other)",
      "[Duplicate report](docs/report.md)",
    ].join("\n");
    for (const workspacePath of ["/synthetic", "C:\\synthetic"]) {
      const cards = assertEquivalent(content, workspacePath, {
        changedFilePaths: ["site/index.html", "docs/report.md"],
      });
      expect(
        cards.find((card) => card.type === "website" && card.url.endsWith("index.html"))?.title,
      ).toBe("index.html");
      expect(cards.some((card) => card.type === "file" && card.kind === "pdf")).toBe(true);
      assertEquivalent(content, workspacePath, {
        changedFilePaths: ["site/index.html", "docs/report.md"],
        suppressWebRemoteCards: true,
      });
    }
    assertEquivalent("[Home](~/report.md) [File](file:///synthetic/report.pdf)", "/synthetic", {
      homePath: "/synthetic/home",
      changedFilePaths: ["/synthetic/home/report.md"],
    });
    const many = Array.from(
      { length: 40 },
      (_, index) => `[Preview ${index}](http://localhost:3000/view-${index})`,
    ).join(" ");
    const cards = assertEquivalent(many);
    expect(cards).toHaveLength(15);
    expect(cards.map((card) => card.title)).toEqual(
      Array.from({ length: 15 }, (_, index) => `Preview ${39 - index}`),
    );
  });

  it("rebuilds from each new string and preserves empty, absent-title and suppressed output", () => {
    expect(assertEquivalent("")).toEqual([]);
    expect(assertEquivalent("  \n\t")).toEqual([]);
    expect(assertEquivalent("No website here report.pdf")).toHaveLength(1);
    expect(assertEquivalent(namedUrl)[0]?.title).toBe("view");
    expect(assertEquivalent(`[Old title](${namedUrl})`)[0]?.title).toBe("Old title");
    expect(assertEquivalent(`[New title](${namedUrl})`)[0]?.title).toBe("New title");
    expect(assertEquivalent(namedUrl, "/another-root", { suppressWebRemoteCards: true })).toEqual(
      [],
    );
    expect(assertEquivalent(namedUrl)[0]?.title).toBe("view");
  });

  it("matches the fixed original builder across deterministic mixed and duplicate documents", () => {
    let seed = 0x7411e;
    const next = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    const labels = [
      "",
      "  中文   title  ",
      "First",
      "Later",
      "***",
      "é😀",
      "https://example.test",
      "x".repeat(81),
    ];
    const urls = [
      namedUrl,
      namedUrl + "?a=1#top",
      "HTTP://LOCALHOST:3000/view",
      "http://localhost:3000/site/index.html",
      "https://127.0.0.1:8443/view",
      "https://example.test/link",
    ];
    for (let index = 0; index < 120; index++) {
      const content =
        Array.from({ length: 1 + next(36) }, () => {
          const url = urls[next(urls.length)]!;
          const label = labels[next(labels.length)]!;
          return next(3) === 0 ? url : `[${label}](${next(4) === 0 ? `<${url}>` : url})`;
        }).join(index % 2 === 0 ? "\n" : " ") + "\n[Report](docs/report.md) report.pdf";
      assertEquivalent(content, index % 2 === 0 ? "/synthetic" : "C:\\synthetic", {
        changedFilePaths: index % 3 === 0 ? ["site/index.html", "docs/report.md"] : [],
        suppressWebRemoteCards: index % 7 === 0,
      });
    }
  });
});

describe("preview title indexing work budget on the production builder", () => {
  it("scans Markdown links once for 32 URLs, without applying the 15-card limit early", () => {
    const content = [
      ...Array.from(
        { length: 512 },
        (_, index) => `[Unrelated ${index}](https://example.test/link-${index})`,
      ),
      ...Array.from(
        { length: 32 },
        (_, index) => `[Preview ${index}](http://localhost:3000/view-${index})`,
      ),
    ].join("\n");
    const options = Object.freeze({ changedFilePaths: Object.freeze([]) });
    const before = countedBuild(() => original(content, "/synthetic", EMPTY_REFERENCES, options));
    const after = countedBuild(() =>
      buildAssistantPreviewCardsFromReferences(content, "/synthetic", EMPTY_REFERENCES, options),
    );
    expect(after.cards).toEqual(before.cards);
    expect(after.cards.map((card) => card.title)).toEqual(
      Array.from({ length: 15 }, (_, index) => `Preview ${31 - index}`),
    );
    expect(before.scans).toBe(32);
    expect(before.matches).toBe(16_912);
    expect(after.scans).toBe(1);
    expect(after.matches).toBe(544);
  });

  it("shares a single negative lookup index across 64 raw URLs", () => {
    const content = [
      ...Array.from(
        { length: 512 },
        (_, index) => `[Other ${index}](https://example.test/link-${index})`,
      ),
      ...Array.from({ length: 64 }, (_, index) => `http://localhost:3000/view-${index}`),
    ].join("\n");
    const before = countedBuild(() => original(content, "/synthetic", EMPTY_REFERENCES));
    const after = countedBuild(() =>
      buildAssistantPreviewCardsFromReferences(content, "/synthetic", EMPTY_REFERENCES),
    );
    expect(after.cards).toEqual(before.cards);
    expect(before.scans).toBe(64);
    expect(before.matches).toBe(32_768);
    expect(after.scans).toBe(1);
    expect(after.matches).toBe(512);
  });

  it("preserves the first-match early exit for a single URL ahead of unrelated links", () => {
    const content = [
      `[First title](${namedUrl})`,
      ...Array.from(
        { length: 512 },
        (_, index) => `[Other ${index}](https://example.test/link-${index})`,
      ),
    ].join("\n");
    const before = countedBuild(() => original(content, "/synthetic", EMPTY_REFERENCES));
    const after = countedBuild(() =>
      buildAssistantPreviewCardsFromReferences(content, "/synthetic", EMPTY_REFERENCES),
    );
    expect(after.cards).toEqual(before.cards);
    expect(before.scans).toBe(1);
    expect(before.matches).toBe(1);
    expect(after.scans).toBe(1);
    expect(after.matches).toBe(1);
  });

  it("reuses a previously encountered title after a negative query exhausts the iterator", () => {
    const content = `http://localhost:3000/missing\n[Known](${namedUrl})\n[Later](${namedUrl})`;
    const before = countedBuild(() => original(content, "/synthetic", EMPTY_REFERENCES));
    const after = countedBuild(() =>
      buildAssistantPreviewCardsFromReferences(content, "/synthetic", EMPTY_REFERENCES),
    );
    expect(after.cards).toEqual(before.cards);
    expect(
      after.cards.find((card) => card.type === "website" && card.url === namedUrl)?.title,
    ).toBe("Known");
    expect(after.scans).toBe(1);
    expect(after.matches).toBe(2);
  });

  it("does not inspect title links when no eligible URL needs them", () => {
    const cases: Array<{ content: string; options?: PreviewOptions }> = [
      { content: "[Other](https://example.test/link) report.pdf" },
      { content: `[Name](${namedUrl})`, options: { suppressWebRemoteCards: true } },
      { content: "[Invalid](http://localhost:65536/view)" },
      {
        content: "[Name](http://localhost:3000/site/index.html)",
        options: { changedFilePaths: Object.freeze(["site/index.html"]) },
      },
      { content: "  \n\t" },
    ];
    for (const { content, options } of cases) {
      const expected = original(content, "/synthetic", EMPTY_REFERENCES, options);
      const actual = countedBuild(() =>
        buildAssistantPreviewCardsFromReferences(content, "/synthetic", EMPTY_REFERENCES, options),
      );
      expect(actual.cards).toEqual(expected);
      expect(actual.scans, content).toBe(0);
      expect(actual.matches, content).toBe(0);
    }
  });
});

it("benchmark: preview-title lookup on the original and current builders", () => {
  const unrelated = Array.from(
    { length: 512 },
    (_, index) => `[Other ${index}](https://example.test/link-${index})`,
  );
  const cases = [
    {
      name: "one early title",
      content: [`[Early](${namedUrl})`, ...unrelated].join("\n"),
      repetitions: 50,
    },
    {
      name: "32 late titles",
      content: [
        ...unrelated,
        ...Array.from(
          { length: 32 },
          (_, index) => `[Preview ${index}](http://localhost:3000/view-${index})`,
        ),
      ].join("\n"),
      repetitions: 5,
    },
    {
      name: "64 negative lookups",
      content: [
        ...unrelated,
        ...Array.from({ length: 64 }, (_, index) => `http://localhost:3000/view-${index}`),
      ].join("\n"),
      repetitions: 5,
    },
  ];
  for (const fixture of cases) {
    const oldTimes: number[] = [];
    const newTimes: number[] = [];
    const before = () => original(fixture.content, "/synthetic", EMPTY_REFERENCES);
    const current = () =>
      buildAssistantPreviewCardsFromReferences(fixture.content, "/synthetic", EMPTY_REFERENCES);
    expect(current()).toEqual(before());
    for (let index = 0; index < 4; index++) {
      before();
      current();
    }
    for (let index = 0; index < 15; index++) {
      const pair =
        index % 2
          ? ([
              [current, newTimes],
              [before, oldTimes],
            ] as const)
          : ([
              [before, oldTimes],
              [current, newTimes],
            ] as const);
      for (const [run, samples] of pair) {
        const start = performance.now();
        for (let iteration = 0; iteration < fixture.repetitions; iteration++) run();
        samples.push((performance.now() - start) / fixture.repetitions);
      }
    }
    const median = (values: number[]) =>
      values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]!;
    console.info(
      JSON.stringify({ fixture: fixture.name, oldMs: median(oldTimes), newMs: median(newTimes) }),
    );
  }
});
