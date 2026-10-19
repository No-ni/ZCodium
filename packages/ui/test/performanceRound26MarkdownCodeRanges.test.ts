import { describe, expect, it, vi } from "vitest";
import * as directiveParser from "@/lib/assistantDirectiveParser.js";
import { findMarkdownCodeRanges } from "@/lib/assistantDirectiveParser.js";
import { projectAssistantCodeComments } from "@/lib/assistantCodeComment.js";
import { projectZCodeFileCitations } from "@/lib/zcodeFileCitation.js";
import { normalizeConversationShareMarkdown } from "@/v4/conversationShareMarkdown.js";
import { referenceMarkdownCodeRanges } from "./performanceRound26MarkdownCodeRanges.reference.js";

const comment =
  '::code-comment{title="检查" body="保留原文" file="src/test.ts" start=2 priority=1}';
const citation = '::zcode-file-citation{path="/work/report.pdf"}';

const edgeCases = [
  "",
  "普通正文 😀 without code",
  "`inline` and ``long ` inline``",
  "`unclosed",
  "before `a`` after",
  "before ``a``` after `b`",
  "before ````a\n```\nb\n```\nc```` after",
  "before `a\n```\nb\n```\nc` after",
  "before ``a\n~~~\n`b\n~~~\nc`` after `d`",
  "before `a\n~~~\n`b\n~~~\nc` after",
  "```ts\nconst t = `value`;\n```\n`outside`",
  "~~~ts\nconst t = `value`;\n~~~\n`outside`",
  "```ts\n```suffix\n`still inside`\n```\n`outside`",
  "```bad`info\ntext `code`\n",
  "  ~~~~md\n~~~\n```\n~~~~\n`outside`",
  "    ```md\n`indented`\n    ```\n`outside`",
  "```md\n未闭合 `fence` 😀",
  "~~~md\n未闭合 `fence` 😀",
  "```\na\n```\n~~~\nb\n~~~\n",
  '<PRE class="example">`a`\n```\nb\n```\n</PRE > `c`',
  "<code>`a</code>`",
  "<pre>one<code>two</code></pre> `three`",
  "<code>unclosed `a`",
  "<code>a</code><pre>b</pre>`c`",
  "before `a\n~~~\nb\n~~~\nc` after",
  `\`\`\`md\n${comment}\n${citation}\n\`\`\`\n${comment}\n${citation}`,
];

function randomDocuments(): string[] {
  let seed = 0x26c0de;
  const next = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const fragments = [
    "正文😀",
    " ",
    "\t",
    "\n",
    "\r",
    "\r\n",
    "`",
    "``",
    "```",
    "````",
    "~~~~",
    "~~~",
    "```ts\n",
    "  ```",
    "    ~~~",
    "`bad-info",
    "tail",
    "<code>",
    "</code>",
    "<PRE class='x'>",
    "</PRE >",
    comment,
    citation,
  ];
  return Array.from({ length: 1500 }, () =>
    Array.from({ length: 1 + next(70) }, () => fragments[next(fragments.length)]).join(""),
  );
}

describe("Markdown code-range equivalent optimization", () => {
  it.each(["\n", "\r\n", "\r"])("preserves all legacy ranges with %j line endings", (newline) => {
    for (const source of edgeCases) {
      const text = source.replaceAll("\n", newline);
      expect(findMarkdownCodeRanges(text), text).toEqual(referenceMarkdownCodeRanges(text));
    }
  });

  it("preserves ranges for deterministic mixed Markdown and streaming prefixes", () => {
    for (const text of randomDocuments()) {
      expect(findMarkdownCodeRanges(text), text).toEqual(referenceMarkdownCodeRanges(text));
    }
    for (const text of edgeCases) {
      for (let end = 0; end <= text.length; end++) {
        const prefix = text.slice(0, end);
        expect(findMarkdownCodeRanges(prefix), prefix).toEqual(referenceMarkdownCodeRanges(prefix));
      }
    }
  });

  it("keeps exact UTF-16 offsets, adjacent merging and end-exclusive fence boundaries", () => {
    const fence = "  ~~~~ts\r\nconst value = `😀`;\r\n  ~~~~~ \t\r\n";
    const inline = "``中文 ` code``";
    const prefix = "😀正文\r\n";
    expect(findMarkdownCodeRanges(prefix + fence + inline + " tail")).toEqual([
      [prefix.length, prefix.length + fence.length + inline.length],
    ]);
    expect(findMarkdownCodeRanges(prefix + fence + " gap " + inline)).toEqual([
      [prefix.length, prefix.length + fence.length],
      [prefix.length + fence.length + 5, prefix.length + fence.length + 5 + inline.length],
    ]);
  });

  it("preserves legacy first-closing-candidate behavior when that candidate is fenced", () => {
    const text = "before `start\n~~~\n`candidate\n~~~\nplain";
    expect(findMarkdownCodeRanges(text)).toEqual([
      [text.indexOf("~~~"), text.lastIndexOf("~~~") + 4],
    ]);
    // 现有规则允许长行内标记跨过只有短反引号的围栏；性能优化不能顺手改变它。
    const crossing = "before ````start\n```\nbody\n```\nend```` tail";
    expect(findMarkdownCodeRanges(crossing)).toEqual([[7, crossing.indexOf(" tail")]]);
  });

  it("preserves complete pre-change comment projections including streaming tails", () => {
    const inputs = [
      ...edgeCases,
      `${comment}\n正文\n${comment}`,
      `before ${comment} after`,
      `${comment}\n::code-comment{title="未完成`,
      `${comment}\n::code-comment`,
      `${comment}\n::zcode-file-cit`,
      `\`${comment}\`\n${comment}`,
      `<pre>${comment}</pre>\n${comment}`,
      `~~~\n${comment}\n~~~\n::code-comment{title="未完成`,
      '::code-comment{title="x" body="y" file="C:\\work\\test.ts" start=4 end=2 priority=8}',
      '::code-comment{title="x" body="y"}\nordinary text',
    ];
    expect(
      inputs.flatMap((text) => [
        projectAssistantCodeComments(text, { streaming: false }),
        projectAssistantCodeComments(text, { streaming: true }),
      ]),
    ).toMatchSnapshot();
  });

  it("keeps protected examples inert and only projects directives in prose", () => {
    const code = `~~~md\n${comment}\n${citation}\n![example](https://example.com/a.png)\n~~~\n`;
    expect(projectAssistantCodeComments(code + comment, { streaming: true })).toEqual({
      comments: [
        {
          title: "检查",
          body: "保留原文",
          file: "src/test.ts",
          startLine: 2,
          endLine: 2,
          priority: 1,
          sourceStart: code.length,
          sourceEnd: code.length + comment.length,
        },
      ],
      visibleText: code,
    });
    expect(
      projectZCodeFileCitations(code + '::zcode-file-citation{path="', { streaming: true }),
    ).toEqual({ visibleText: code });
    expect(
      normalizeConversationShareMarkdown(code + citation, new Map([["a", "report.pdf"]])),
    ).toBe(code + "report.pdf");
  });

  it("does not reuse code ranges from an earlier text version", () => {
    for (const text of [comment, `~~~\n${comment}`, comment, `\`${comment}\``, comment]) {
      const result = projectAssistantCodeComments(text, { streaming: true });
      expect(result.comments.length).toBe(text === comment ? 1 : 0);
      expect(result.visibleText).toBe(text === comment ? "" : text);
    }
  });

  it("parses code protection once per streaming comment projection", () => {
    const parse = vi.spyOn(directiveParser, "findMarkdownCodeRanges");
    try {
      const code = `~~~\n${comment}\n~~~\n`.repeat(240);
      const text = `${code}${comment}\n::code-comment{title="pending`;
      const result = projectAssistantCodeComments(text, { streaming: true });
      expect(result.visibleText).toBe(code);
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]?.sourceStart).toBe(code.length);
      expect(parse).toHaveBeenCalledExactlyOnceWith(text);
    } finally {
      parse.mockRestore();
    }
  });
});
