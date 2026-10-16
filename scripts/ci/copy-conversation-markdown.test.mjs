import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { marked } from "marked";

const uiImport = {
  parentURL: import.meta.url,
  tsconfig: new URL("../../packages/ui/tsconfig.json", import.meta.url).pathname,
};

const { formatConversationMarkdown } = await tsImport(
  "../../packages/ui/src/lib/conversationMarkdown.ts",
  uiImport,
);
const { readConversationMarkdown } = await tsImport(
  "../../packages/ui/src/lib/readConversationMarkdown.ts",
  uiImport,
);
const { writeBrowserClipboardText, isBrowserClipboardAvailable } = await tsImport(
  "../../packages/ui/src/lib/browserClipboard.ts",
  uiImport,
);

const base = { turnId: "turn", productTurnId: "product", createdAt: 1, createdAtSeq: 1 };
const user = (rowId, text) => ({ ...base, rowId, kind: "userInput", origin: "realUser", text });
const assistant = (rowId, text) => ({
  ...base,
  rowId,
  kind: "assistantText",
  state: "complete",
  text,
});
const target = {
  workspacePath: "/fixture",
  workspaceIdentity: "remote-fixture",
  remoteSessionId: "remote-host",
  sessionId: "session-a",
  title: "My conversation",
  showReasoning: true,
};

test("chronological Markdown preserves prose and folds readable work records", () => {
  const prose = "A table\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst a = 1;\n```";
  const rows = [
    user(1, "> quoted prompt\n\n- one\n- two"),
    { ...base, rowId: 2, kind: "reasoning", state: "complete", text: "Visible reasoning" },
    {
      ...base,
      rowId: 3,
      kind: "toolCall",
      toolCallId: "tool",
      toolName: "Bash<&>",
      status: "success",
      inputText: "echo test",
      output: {
        text: "````\n</details>\n````",
        truncated: { totalBytes: 99, ref: "private-output-ref" },
      },
    },
    assistant(4, prose),
    {
      ...base,
      rowId: 5,
      kind: "subagent",
      subagentType: "explore",
      status: "success",
      summaryText: "Child summary",
      childSessionId: "private-child",
    },
    {
      ...base,
      rowId: 6,
      kind: "timelineMarker",
      marker: { type: "goalSet", objective: "Finish the work" },
    },
  ];
  const markdown = formatConversationMarkdown("Title", rows, true);
  assert.ok(markdown.startsWith("# Title\n\n## User\n\n"));
  assert.ok(markdown.includes(prose));
  assert.match(markdown, /<summary>Tool: Bash&lt;&amp;&gt;<\/summary>/);
  assert.match(markdown, /`````\n````\n<\/details>\n````\n`````/);
  assert.match(markdown, /Output truncated/);
  assert.match(markdown, /Child summary/);
  assert.match(markdown, /Finish the work/);
  assert.doesNotMatch(markdown, /private-output-ref|private-child/);
  assert.ok(markdown.indexOf("quoted prompt") < markdown.indexOf("Visible reasoning"));
  assert.ok(markdown.indexOf("Visible reasoning") < markdown.indexOf("echo test"));
  assert.ok(markdown.indexOf("echo test") < markdown.indexOf(prose));
});

test("citation links are readable, code examples and attachment names remain intact", () => {
  const directive = ':zcode-file-citation{path="/fixture/My report.pdf"}';
  const markdown = formatConversationMarkdown(
    "Files",
    [
      {
        ...user(1, "See attached"),
        attachments: [
          {
            ref: "zcode-attachment://private",
            fileName: "image.png",
            mime: "image/png",
            bytes: 10,
          },
          {
            ref: "https://example.com/report.pdf",
            fileName: "Report",
            mime: "application/pdf",
            bytes: 10,
          },
        ],
      },
      assistant(2, `${directive}\n\n\`\`\`text\n${directive}\n\`\`\``),
    ],
    true,
  );
  assert.match(markdown, /\[My report\.pdf\]\(<file:\/\/\/fixture\/My%20report\.pdf>\)/);
  assert.match(markdown, /```text\n:zcode-file-citation/);
  assert.match(markdown, /image\.png/);
  assert.match(markdown, /\[Report\]\(<https:\/\/example\.com\/report\.pdf>\)/);
  assert.doesNotMatch(markdown, /zcode-attachment:\/\/private/);
});

test("unfinished fences cannot swallow subsequent messages or export containers", () => {
  for (const text of [
    "```js\nconst a = 1;",
    "~~~~text\nbody\n~~~",
    "```",
    "```js\nbody\n```not a closing fence",
  ]) {
    const markdown = formatConversationMarkdown(
      "Fence",
      [user(1, text), assistant(2, "Visible answer")],
      true,
    );
    const tokens = marked.lexer(markdown);
    assert.deepEqual(
      tokens.filter((token) => token.type === "heading").map((token) => token.text),
      ["Fence", "User", "Assistant"],
    );
    assert.ok(
      tokens.some((token) => token.type === "paragraph" && token.text === "Visible answer"),
    );
    assert.ok(tokens.some((token) => token.type === "code"));
  }
  const nested = formatConversationMarkdown(
    "List",
    [user(1, "- item\n\n  ```js\n  const a = 1;"), assistant(2, "After list")],
    true,
  );
  assert.ok(
    marked.lexer(nested).some((token) => token.type === "paragraph" && token.text === "After list"),
  );
  const reasoning = formatConversationMarkdown(
    "Reasoning",
    [
      { ...base, rowId: 1, kind: "reasoning", state: "streaming", text: "```text\npartial" },
      assistant(2, "After reasoning"),
    ],
    true,
  );
  assert.ok(
    marked
      .lexer(reasoning)
      .some((token) => token.type === "paragraph" && token.text === "After reasoning"),
  );
});

test("non-closing fences keep citation examples literal", () => {
  const directive = ':zcode-file-citation{path="/fixture/example.pdf"}';
  const markdown = formatConversationMarkdown(
    "Example",
    [
      assistant(1, `\`\`\`text\n\`\`\`not a closing fence\n${directive}`),
      assistant(2, "Next answer"),
    ],
    true,
  );
  const code = marked.lexer(markdown).find((token) => token.type === "code");
  assert.ok(code?.text.includes(directive));
  assert.ok(
    marked
      .lexer(markdown)
      .some((token) => token.type === "paragraph" && token.text === "Next answer"),
  );
});

test("citation code boundaries follow CommonMark whitespace and line endings", () => {
  const directive = ':zcode-file-citation{path="/fixture/example.pdf"}';
  for (const ending of ["\n", "\r\n", "\r"]) {
    for (const suffix of ["not a closing fence", "\u00a0"]) {
      const markdown = formatConversationMarkdown(
        "Example",
        [
          assistant(1, ["```text", `\`\`\`${suffix}`, directive].join(ending)),
          assistant(2, "Next answer"),
        ],
        true,
      );
      assert.ok(
        marked
          .lexer(markdown)
          .find((token) => token.type === "code")
          ?.text.includes(directive),
      );
      assert.ok(
        marked
          .lexer(markdown)
          .some((token) => token.type === "paragraph" && token.text === "Next answer"),
      );
    }
    const closed = formatConversationMarkdown(
      "Closed",
      [assistant(1, ["```text", directive, "```", "", directive].join(ending))],
      true,
    );
    assert.ok(
      marked
        .lexer(closed)
        .find((token) => token.type === "code")
        ?.text.includes(directive),
    );
    assert.match(closed, /\[example\.pdf\]\(<file:\/\/\/fixture\/example\.pdf>\)/);
  }
  const invalidOpening = formatConversationMarkdown(
    "Example",
    [assistant(1, `\`\`\`bad\`info\n${directive}`)],
    true,
  );
  assert.match(invalidOpening, /\[example\.pdf\]\(<file:\/\/\/fixture\/example\.pdf>\)/);
});

test("local paths round-trip with reserved characters and Windows separators", () => {
  const markdown = formatConversationMarkdown(
    "**Title** <main>",
    [
      {
        ...user(1, "Files"),
        attachments: [
          {
            ref: "/fixture/report#draft%20?.pdf",
            fileName: "*Draft* &copy;.pdf",
            mime: "application/pdf",
            bytes: 1,
          },
          {
            ref: "C:\\Docs\\report#draft%.pdf",
            fileName: "Windows",
            mime: "application/pdf",
            bytes: 1,
          },
          {
            ref: "https://example.com/report%20draft.pdf?q=1#summary",
            fileName: "Remote",
            mime: "application/pdf",
            bytes: 1,
          },
        ],
      },
    ],
    true,
  );
  const html = marked.parse(markdown);
  assert.match(html, /href="file:\/\/\/fixture\/report%23draft%2520%3F\.pdf"/);
  assert.match(html, /href="file:\/\/\/C:\/Docs\/report%23draft%25\.pdf"/);
  assert.match(html, /href="https:\/\/example\.com\/report%20draft\.pdf\?q=1#summary"/);
  assert.match(html, /\*Draft\* &amp;copy;\.pdf/);
  assert.doesNotMatch(html, /<strong>|<main>/);
});

test("messages that become empty after citation projection do not create empty sections", () => {
  const text = ':zcode-file-citation{path=""}';
  assert.equal(formatConversationMarkdown("Empty", [assistant(1, text)], true), "");
  assert.equal(
    formatConversationMarkdown(
      "Empty",
      [{ ...base, rowId: 1, kind: "reasoning", state: "complete", text }],
      true,
    ),
    "",
  );
});

test("workflow launch and settings cards are exported once without internal identifiers", () => {
  const launch = {
    runId: "private-run",
    toolCallId: "private-launch",
    name: "Saved workflow",
    description: "Launch description",
    args: { count: 3 },
    path: "/private-script",
    script: "private-script-body",
  };
  for (const metadataOnHeader of [true, false]) {
    const markdown = formatConversationMarkdown(
      "Workflow",
      [
        {
          ...base,
          rowId: 1,
          kind: "turnHeader",
          origin: "workflowLaunch",
          executionKind: "controlOnly",
          state: "completedSuccess",
          startedAt: 1,
          ...(metadataOnHeader ? { workflowLaunch: launch } : {}),
        },
        {
          ...user(2, "INTERNAL synthetic input"),
          origin: "workflowLaunch",
          workflowLaunch: launch,
        },
      ],
      true,
    );
    assert.match(markdown, /Saved workflow/);
    assert.match(markdown, /Launch description/);
    assert.match(markdown, /"count": 3/);
    assert.equal(markdown.match(/Saved workflow/g)?.length, 1);
    assert.doesNotMatch(markdown, /private-run|private-launch|private-script|INTERNAL/);
  }
  const settings = formatConversationMarkdown(
    "Settings",
    [
      {
        ...base,
        rowId: 1,
        kind: "turnHeader",
        origin: "workflowLaunch",
        state: "completedSuccess",
        startedAt: 1,
        workflowLaunch: { ...launch, amend: { maxConcurrency: { from: 4, to: 2 } } },
      },
    ],
    true,
  );
  assert.match(settings, /Workflow settings updated/);
  assert.match(settings, /Max concurrency: 4 → 2/);
});

test("reasoning preference follows the timeline and empty/internal rows stay absent", () => {
  const reasoning = (rowId, text, turnId = "turn") => ({
    ...base,
    rowId,
    turnId,
    kind: "reasoning",
    state: "complete",
    text,
  });
  const rows = [
    reasoning(1, ""),
    reasoning(2, "First"),
    reasoning(3, "Hidden later"),
    reasoning(4, "Next turn", "turn-2"),
  ];
  const hidden = formatConversationMarkdown("Thinking", rows, false);
  assert.match(hidden, /First/);
  assert.match(hidden, /Next turn/);
  assert.doesNotMatch(hidden, /Hidden later/);
  assert.match(formatConversationMarkdown("Thinking", rows, true), /Hidden later/);
  assert.equal(formatConversationMarkdown("Empty", [user(1, " ")], true), "");
  assert.equal(
    formatConversationMarkdown(
      "Internal",
      [
        {
          ...base,
          rowId: 1,
          kind: "toolCall",
          toolCallId: "mode",
          toolName: "EnterPlanMode",
          inputText: "{}",
          status: "success",
        },
      ],
      true,
    ),
    "",
  );
});

test("running tool previews, errors, Hook executions and interrupted turns remain readable", () => {
  const markdown = formatConversationMarkdown(
    "State",
    [
      {
        ...base,
        rowId: 1,
        kind: "turnHeader",
        origin: "userInput",
        state: "completedInterrupted",
        startedAt: 1,
      },
      user(2, "Run it"),
      {
        ...base,
        rowId: 3,
        kind: "toolCall",
        toolCallId: "run",
        toolName: "Bash",
        status: "running",
        inputText: "long task",
        outputPreview: {
          text: "still working",
          fullText: "started\nstill working",
          totalLines: 2,
          totalBytes: 25,
          linesEstimated: false,
        },
      },
      {
        ...base,
        rowId: 4,
        kind: "toolCall",
        toolCallId: "failed",
        toolName: "Read",
        status: "error",
        inputText: "file",
        error: { code: "not_found", message: "File unavailable" },
      },
      {
        ...base,
        rowId: 5,
        kind: "hookInvocation",
        hookInvocationId: "hook",
        hookEventName: "Stop",
        executions: [
          {
            didExecute: true,
            displayName: "Project check",
            state: "completed",
            outcome: "success",
          },
        ],
      },
    ],
    true,
  );
  assert.match(markdown, /Interrupted/);
  assert.match(markdown, /still working/);
  assert.match(markdown, /File unavailable/);
  assert.match(markdown, /Project check/);
});

test("all history pages are ordered and keep the exact click-time workspace/session", async () => {
  const calls = [];
  const pages = [
    [assistant(5, "Latest")],
    [user(3, "Middle"), assistant(4, "Reply")],
    [user(1, "Oldest"), assistant(2, "First reply")],
  ];
  const markdown = await readConversationMarkdown(async (input) => {
    calls.push(input);
    return {
      rows: pages[calls.length - 1],
      hasMore: calls.length < pages.length,
      atRevision: 7,
      atLogEpoch: "epoch",
    };
  }, target);
  assert.deepEqual(
    calls.map((call) => call.beforeRowId),
    [undefined, 5, 3],
  );
  for (const call of calls) {
    assert.equal(call.workspacePath, target.workspacePath);
    assert.equal(call.workspaceIdentity, target.workspaceIdentity);
    assert.equal(call.remoteSessionId, target.remoteSessionId);
    assert.equal(call.sessionId, target.sessionId);
  }
  assert.ok(markdown.indexOf("Oldest") < markdown.indexOf("Middle"));
  assert.ok(markdown.indexOf("Middle") < markdown.indexOf("Latest"));
});

test("changed revisions/epochs, broken cursors, unordered pages and empty sessions reject", async () => {
  for (const failure of ["revision", "epoch", "cursor", "order", "empty"]) {
    let reads = 0;
    await assert.rejects(
      readConversationMarkdown(async () => {
        reads++;
        if (failure === "empty")
          return { rows: [], hasMore: false, atRevision: 1, atLogEpoch: "e" };
        if (reads === 1)
          return { rows: [assistant(4, "latest")], hasMore: true, atRevision: 1, atLogEpoch: "e" };
        return {
          rows:
            failure === "cursor"
              ? [user(4, "repeated")]
              : failure === "order"
                ? [user(3, "three"), user(2, "two")]
                : [user(1, "earliest")],
          hasMore: false,
          atRevision: failure === "revision" ? 2 : 1,
          atLogEpoch: failure === "epoch" ? "changed" : "e",
        };
      }, target),
      (error) =>
        error.code ===
        (failure === "empty"
          ? "empty"
          : failure === "revision" || failure === "epoch"
            ? "changed"
            : "read"),
    );
    assert.ok(reads <= 2);
  }
});

test("oversized histories and UTF-8 text reject instead of silently truncating", async () => {
  let nextRowId = 1_000_000;
  let reads = 0;
  await assert.rejects(
    readConversationMarkdown(async ({ limit }) => {
      reads++;
      const rows = Array.from({ length: limit }, (_, index) =>
        user(nextRowId - limit + index, "x"),
      );
      nextRowId -= limit;
      return { rows, hasMore: true, atRevision: 1, atLogEpoch: "e" };
    }, target),
    (error) => error.code === "limit",
  );
  assert.ok(reads < 1000);
  await assert.rejects(
    readConversationMarkdown(
      async () => ({
        rows: [assistant(1, "文".repeat(11 * 1024 * 1024))],
        hasMore: false,
        atRevision: 1,
        atLogEpoch: "e",
      }),
      target,
    ),
    (error) => error.code === "limit",
  );
});

test("clipboard is submitted synchronously with promised content and propagates failures", async (t) => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalItem = globalThis.ClipboardItem;
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
    if (originalItem === undefined) delete globalThis.ClipboardItem;
    else globalThis.ClipboardItem = originalItem;
  });
  let resolveContent,
    submitted = false,
    copied = "old";
  const content = new Promise((resolve) => {
    resolveContent = resolve;
  });
  globalThis.ClipboardItem = class {
    constructor(items) {
      this.items = items;
    }
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        write: async ([item]) => {
          submitted = true;
          copied = await (await item.items["text/plain"]).text();
        },
      },
    },
  });
  const write = writeBrowserClipboardText(content);
  assert.equal(submitted, true);
  assert.equal(copied, "old");
  resolveContent("# Complete conversation");
  await write;
  assert.equal(copied, "# Complete conversation");
  assert.equal(isBrowserClipboardAvailable(), true);
  await assert.rejects(writeBrowserClipboardText(Promise.reject(new Error("read failed"))));
  assert.equal(copied, "# Complete conversation");
  navigator.clipboard.write = async () => {
    throw new Error("Clipboard denied");
  };
  await assert.rejects(
    writeBrowserClipboardText(Promise.reject(new Error("Read also failed"))),
    /Clipboard denied/,
  );
  assert.equal(copied, "# Complete conversation");
  delete globalThis.ClipboardItem;
  navigator.clipboard.writeText = async (value) => {
    copied = value;
  };
  await writeBrowserClipboardText("Fallback");
  assert.equal(copied, "Fallback");
  assert.equal(isBrowserClipboardAvailable(), true);
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  assert.equal(isBrowserClipboardAvailable(), false);
  await assert.rejects(writeBrowserClipboardText("Unavailable"), /clipboard_unavailable/);
});
