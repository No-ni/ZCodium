import assert from "node:assert/strict";
import test from "node:test";
import type { FilePart, MessageWithParts, Model, ModelMessageContent } from "@zcode/contracts";
import {
  buildUserMessageEntries,
  cloneRuntimeMessageEntry,
  createMessageHistory,
  createRuntimeToolResultEntry,
  type RuntimeCanonicalEntryIdentity,
  type RuntimeMessageEntry,
  type UserMessageAttachment,
} from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import {
  appendOutputTokenContinuation,
  commitAssistantToTurnRequest,
  completeTurnRequestCanonicalImagePartIds,
} from "../src/runtime/methods/turn-output-token-continuation.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RegularTurnLoopState } from "../src/runtime/methods/turn-loop-state.js";
import type { RuntimeModelTextResult } from "../src/runtime/types.js";

const image = "data:image/png;base64,bmF0aXZlLWNhbm9uaWNhbA==";
const canonicalOf = (entries: readonly RuntimeMessageEntry[]) =>
  entries.map((entry) => entry.canonical);
const messageInfo = (id: string, role: "user" | "assistant", created = 7) =>
  (role === "user"
    ? { id, role, sessionID: "canonical-session", time: { created }, agent: "fixture" }
    : {
        id,
        role,
        sessionID: "canonical-session",
        time: { created },
        agent: "fixture",
        parentID: "prompt",
        mode: "build",
        path: { cwd: "/fixture", root: "/fixture" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }) as MessageWithParts["info"];
const filePart = (id: string, mime: string, source?: FilePart["source"]): FilePart =>
  ({
    id,
    type: "file",
    messageID: "prompt",
    sessionID: "canonical-session",
    mime,
    url: mime.startsWith("image/") ? image : "data:application/pdf;base64,cGRm",
    filename: id,
    ...(source ? { source } : {}),
  }) as FilePart;

test("live user and hydration bind the same real parts after image grouping", async () => {
  const localSource = {
    type: "file",
    path: "/fixture/image.png",
    text: { value: "@image", start: 0, end: 6 },
  } as FilePart["source"];
  const parts = [
    filePart("pasted", "image/png"),
    filePart("pdf", "application/pdf"),
    filePart("local", "image/png", localSource),
  ];
  const attachments: UserMessageAttachment[] = parts.map((part) => ({
    ...part,
    contentBlock: part.mime.startsWith("image/")
      ? {
          type: "image",
          mediaType: part.mime,
          dataUrl: image,
          source: { id: part.id, kind: part.source ? "local_file" : "inline" },
        }
      : { type: "file", mediaType: "application/pdf", dataUrl: part.url, name: part.filename },
  }));
  const live = buildUserMessageEntries("ask", attachments, {
    messageId: "prompt",
    createdAt: 7,
    partId: "prompt-text",
  });
  const history = createMessageHistory();
  await hydrateMessageHistoryFromSession({
    history,
    messages: [
      {
        info: messageInfo("prompt", "user"),
        parts: [
          {
            id: "prompt-text",
            type: "text",
            text: "ask",
            messageID: "prompt",
            sessionID: "canonical-session",
          },
          ...parts,
        ],
      } as MessageWithParts,
    ],
  });
  assert.deepEqual(canonicalOf(history.toRuntimeEntries()), canonicalOf(live));
  assert.deepEqual(live[0].canonical?.imagePartIds, ["local", "pasted"]);
  assert.equal(live[0].canonical?.partId, "prompt-text");
});

test("hydration numbers all real user fragments together and retains their part IDs", async () => {
  const history = createMessageHistory();
  await hydrateMessageHistoryFromSession({
    history,
    messages: [
      {
        info: messageInfo("prompt", "user"),
        parts: [
          {
            id: "prompt-text",
            type: "text",
            text: "ask",
            messageID: "prompt",
            sessionID: "canonical-session",
          },
          {
            id: "notice",
            type: "text",
            text: "tool notice",
            synthetic: true,
            metadata: { source: "tool_hook_context" },
            messageID: "prompt",
            sessionID: "canonical-session",
          },
          { ...filePart("inline-text", "text/plain"), metadata: { preview: { text: "material" } } },
        ],
      } as MessageWithParts,
    ],
  });
  assert.deepEqual(canonicalOf(history.toRuntimeEntries()), [
    { messageId: "prompt", createdAt: 7, entryIndex: 0, partId: "prompt-text" },
    { messageId: "prompt", createdAt: 7, entryIndex: 1, partId: "notice" },
    { messageId: "prompt", createdAt: 7, entryIndex: 2, partId: "inline-text" },
  ]);
});

test("canonical clones isolate IDs and images without placing them in model messages", () => {
  const identity: RuntimeCanonicalEntryIdentity = {
    messageId: "assistant",
    createdAt: 3,
    entryIndex: 1,
    partId: "tool",
    imagePartIds: ["image"],
  };
  const entry = {
    ...createRuntimeToolResultEntry("call", "Read", "result", false),
    canonical: identity,
  };
  const history = createMessageHistory();
  history.addEntries([entry]);
  (identity.imagePartIds as string[]).push("source-mutation");
  const snapshot = history.toRuntimeEntries();
  (snapshot[0]!.canonical!.imagePartIds as string[]).push("snapshot-mutation");
  history.replaceMessages(history.toRuntimeEntries());
  const cloned = cloneRuntimeMessageEntry(history.toRuntimeEntries()[0]!);
  assert.deepEqual(cloned.canonical?.imagePartIds, ["image"]);
  assert.equal("canonical" in (cloned as { message: object }).message, false);
  const reminder: RuntimeMessageEntry = {
    kind: "attachment",
    content: "notice",
    metadata: { source: "tool_hook_context" },
    canonical: identity,
  };
  assert.notEqual(
    cloneRuntimeMessageEntry(reminder).canonical?.imagePartIds,
    identity.imagePartIds,
  );
});

test("committed assistant rounds use the actual message and server tool part IDs", async () => {
  const history = createMessageHistory();
  const requestState = {
    entries: [] as readonly RuntimeMessageEntry[],
    outputTokenContinuationCount: 0,
  };
  const model = { providerId: "fixture-provider", modelId: "fixture-model" } as Model;
  const state = {
    model,
    modelResponse: "final",
    turnRequestState: requestState,
  } as RegularTurnLoopState;
  const result = {
    text: "final",
    finishReason: "stop",
    usage: {},
    providerToolRounds: [
      {
        messageId: "assistant",
        toolPartId: "server-part",
        text: "server round",
        reasoning: [],
        toolCall: { id: "server-call", name: "Search", input: {} },
        result: { output: "server result", isError: false },
      },
    ],
  } as RuntimeModelTextResult;
  const runtime = { messageHistory: history } as AgentRuntimeInternal;
  assert.equal(
    commitAssistantToTurnRequest(runtime, state, result, undefined, {
      messageId: "assistant",
      createdAt: 9,
    }),
    true,
  );
  const cold = createMessageHistory();
  await hydrateMessageHistoryFromSession({
    history: cold,
    messages: [
      {
        info: messageInfo("assistant", "assistant", 9),
        parts: [
          {
            id: "server-text",
            type: "text",
            text: "server round",
            messageID: "assistant",
            sessionID: "canonical-session",
          },
          {
            id: "server-part",
            type: "tool",
            callID: "server-call",
            tool: "Search",
            metadata: { providerExecuted: true },
            messageID: "assistant",
            sessionID: "canonical-session",
            state: {
              status: "completed",
              input: {},
              output: "server result",
              title: "Search",
              metadata: {},
              time: { start: 9, end: 10 },
            },
          },
          {
            id: "final-text",
            type: "text",
            text: "final",
            messageID: "assistant",
            sessionID: "canonical-session",
          },
        ],
      } as MessageWithParts,
    ],
  });
  assert.deepEqual(canonicalOf(history.toRuntimeEntries()), canonicalOf(cold.toRuntimeEntries()));
  assert.equal(history.toRuntimeEntries()[1]?.canonical?.partId, "server-part");
  appendOutputTokenContinuation(requestState);
  assert.equal(requestState.entries.at(-1)?.canonical, undefined);
});

test("successful tool media enriches both histories without changing input or entry count", () => {
  const history = createMessageHistory();
  const canonical = { messageId: "assistant", createdAt: 9, entryIndex: 1, partId: "actual-tool" };
  const content: ModelMessageContent = [{ type: "image", mediaType: "image/png", dataUrl: image }];
  const entry = { ...createRuntimeToolResultEntry("call", "Read", content, false), canonical };
  history.addEntries([entry]);
  const requestState = {
    entries: [entry] as readonly RuntimeMessageEntry[],
    outputTokenContinuationCount: 0,
  };
  const runtime = { messageHistory: history } as AgentRuntimeInternal;
  completeTurnRequestCanonicalImagePartIds(runtime, requestState, canonical, ["actual-image"]);
  assert.equal(history.getMessageCount(), 1);
  assert.equal(requestState.entries.length, 1);
  assert.deepEqual(history.toRuntimeEntries()[0]?.canonical?.imagePartIds, ["actual-image"]);
  assert.deepEqual(requestState.entries[0]?.canonical?.imagePartIds, ["actual-image"]);
  assert.deepEqual(
    (history.toRuntimeEntries()[0] as { message: { content: unknown } }).message.content,
    content,
  );
  completeTurnRequestCanonicalImagePartIds(
    runtime,
    requestState,
    { ...canonical, partId: "other-tool" },
    ["wrong-image"],
  );
  assert.deepEqual(history.toRuntimeEntries()[0]?.canonical?.imagePartIds, ["actual-image"]);
});

test("unpersisted input never gains guessed canonical identity", () => {
  const entries = buildUserMessageEntries("same text", []);
  assert.equal(entries[0].canonical, undefined);
  const knownMessage = buildUserMessageEntries(
    [{ type: "image", mediaType: "image/png", dataUrl: image }],
    [],
    { messageId: "prompt", createdAt: 0 },
  );
  assert.equal(knownMessage[0].canonical?.createdAt, 0);
  assert.equal(knownMessage[0].canonical?.imagePartIds, undefined);
});

test("cold tool image identities follow actual media layout and retain error/interruption parts", async () => {
  const history = createMessageHistory();
  const firstImage = { ...filePart("first-image", "image/png"), messageID: "assistant" };
  const secondImage = { ...filePart("second-image", "image/png"), messageID: "assistant" };
  const pdf = { ...filePart("tool-pdf", "application/pdf"), messageID: "assistant" };
  await hydrateMessageHistoryFromSession({
    history,
    messages: [
      {
        info: messageInfo("assistant", "assistant", 0),
        parts: [
          {
            id: "answer",
            type: "text",
            text: "calls",
            messageID: "assistant",
            sessionID: "canonical-session",
          },
          {
            id: "tool-completed",
            type: "tool",
            callID: "completed",
            tool: "Read",
            declarationIndex: 0,
            messageID: "assistant",
            sessionID: "canonical-session",
            state: {
              status: "completed",
              input: {},
              output: "media",
              title: "Read",
              attachments: [firstImage, pdf, secondImage],
              metadata: {
                modelContentLayout: [
                  { type: "attachment", attachmentIndex: 2 },
                  { type: "attachment", attachmentIndex: 1 },
                  { type: "attachment", attachmentIndex: 0 },
                ],
              },
              time: { start: 0, end: 1 },
            },
          },
          {
            id: "tool-error",
            type: "tool",
            callID: "error",
            tool: "Read",
            declarationIndex: 1,
            messageID: "assistant",
            sessionID: "canonical-session",
            state: { status: "error", input: {}, error: "failure", time: { start: 0, end: 1 } },
          },
          {
            id: "tool-interrupted",
            type: "tool",
            callID: "interrupted",
            tool: "Read",
            declarationIndex: 2,
            messageID: "assistant",
            sessionID: "canonical-session",
            state: { status: "running", input: {}, time: { start: 0 } },
          },
        ],
      } as MessageWithParts,
    ],
  });
  const entries = history.toRuntimeEntries();
  assert.deepEqual(
    entries.map((entry) => entry.canonical?.entryIndex),
    [0, 1, 2, 3],
  );
  assert.deepEqual(entries[1]?.canonical?.imagePartIds, ["second-image", "first-image"]);
  assert.deepEqual(
    entries.slice(1).map((entry) => entry.canonical?.partId),
    ["tool-completed", "tool-error", "tool-interrupted"],
  );
  assert.ok(entries.every((entry) => entry.canonical?.createdAt === 0));
});

test("request clones cannot rewrite original image evidence", () => {
  const history = createMessageHistory();
  const originalImage = {
    artifactUri: "zcode-artifact://fixture/original",
    sha256: "fixture",
    bytes: 1,
    mediaType: "image/png",
    sourceKind: "attachment" as const,
    preserveRaster: true,
  };
  history.addEntries([
    {
      message: {
        role: "user",
        content: [
          {
            type: "image",
            mediaType: "image/png",
            dataUrl: image,
            source: { id: "actual-image", kind: "inline", originalImage },
          },
        ],
      },
    },
  ]);
  const snapshot = history.toRuntimeEntries()[0]!;
  if (snapshot.kind === "attachment" || !Array.isArray(snapshot.message.content))
    throw new Error("missing image fixture");
  const block = snapshot.message.content[0]!;
  if (block.type !== "image") throw new Error("missing image fixture");
  block.source!.originalImage!.artifactUri = "zcode-artifact://fixture/changed";
  assert.equal(originalImage.artifactUri, "zcode-artifact://fixture/original");
  assert.equal(
    (
      history.toRuntimeEntries()[0] as {
        message: { content: Array<{ source: { originalImage: { artifactUri: string } } }> };
      }
    ).message.content[0]!.source.originalImage.artifactUri,
    "zcode-artifact://fixture/original",
  );
});
