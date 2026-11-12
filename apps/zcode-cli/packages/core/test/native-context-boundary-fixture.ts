import type { TestContext } from "node:test";
import {
  createMessageId,
  createPartId,
  createSessionId,
  type MessageWithParts,
  type SessionId,
} from "@zcode/contracts";
import type { CompressionBlock } from "acp-kernel";
import type {
  NativeContextForkBundle,
  NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { SqliteSessionStoreOptions } from "../../adapters/src/storage/session-store/options.js";
import {
  observation,
  operation,
  sessionInput,
} from "../../adapters/test/fixtures/native-context-store.js";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { initialNativeState, kernelOf } from "../src/runtime/native-context-compression/state.js";
import { syncNativeSources } from "../src/runtime/native-context-compression/sources.js";

export { observation, operation };
export const PARENT = createSessionId("native-boundary-parent");
export const CHILD = createSessionId("native-boundary-child");
export const countTokens = (text: string) => Math.ceil(text.length / 4);
export const HASH = "2".repeat(64);

export function message(
  id: string,
  role: "user" | "assistant" = "user",
  sessionID: SessionId = PARENT,
): MessageWithParts {
  const messageID = createMessageId(id);
  const shared = { id: messageID, sessionID, role, time: { created: 10 }, agent: "fixture" };
  return {
    info:
      role === "user"
        ? { ...shared, role }
        : {
            ...shared,
            role,
            parentID: createMessageId("first"),
            time: { created: 10, completed: 20 },
            mode: "build",
            path: { cwd: "fixture-workspace", root: "fixture-workspace" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "completed",
          },
    parts: [
      {
        id: createPartId(`${id}-text`),
        sessionID,
        messageID,
        type: "text",
        text: `合成历史 ${id}`,
      },
    ],
  };
}

export function compactMessage(id = "compact-summary"): MessageWithParts {
  const summary = message(id);
  summary.info = {
    ...summary.info,
    role: "user",
    summary: { title: "Compact summary", body: "合成摘要", diffs: [] },
  };
  summary.parts.push({
    id: createPartId(`${id}-boundary`),
    messageID: summary.info.id,
    sessionID: PARENT,
    type: "compaction",
    auto: false,
    compactBoundary: {
      boundaryId: "compact-boundary",
      trigger: "manual",
      preCompactTokenCount: 100,
      truePostCompactTokenCount: 20,
      summarizedMessageCount: 2,
      summaryMessageIds: [summary.info.id],
      traceId: "fixture-trace" as never,
    },
  });
  return summary;
}

export function block(
  id: string,
  rawIds: string[],
  directBlockIds: string[] = [],
): CompressionBlock {
  return {
    blockId: id,
    runId: `run-${id}`,
    tier: directBlockIds.length ? 2 : 1,
    summary: `合成块 ${id}`,
    directMessageIds: directBlockIds.length ? [] : rawIds,
    effectiveMessageIds: rawIds,
    directBlockIds,
    compressedTokens: 20,
    createdAt: 10,
    survivedCount: 0,
    generation: "young",
    active: true,
  };
}

export async function fixture(
  t: TestContext,
  messages = [message("first"), message("response", "assistant"), message("future")],
  options: SqliteSessionStoreOptions = {},
) {
  const store = await createSqliteSessionStore({ ...options, dbPath: ":memory:" });
  t.after(() => store.close());
  await store.createSession(sessionInput(PARENT));
  if (messages.length) await store.commitMessageBundle({ sessionID: PARENT, messages });
  const history = new MessageHistoryImpl();
  await hydrateMessageHistoryFromSession({ history, messages });
  const events: unknown[] = [];
  const host = {
    branchGeneration: 0,
    sessionId: PARENT,
    config: {},
    messageHistory: history,
    sessionStore: store,
    sessionPersisted: true,
    workingDirectory: "fixture-workspace",
    workspaceRoot: "fixture-workspace",
    rootTraceContext: { traceId: "fixture-trace", spanId: "fixture-span" },
    getSessionModelSelection: () => undefined,
    createEvent: (type: string, payload: unknown) => ({ type, payload }),
    appendEvent: async (event: unknown) => {
      events.push(event);
    },
  } as unknown as AgentRuntimeInternal;
  const state = initialNativeState(host);
  state.policy.policyVersion = 3;
  syncNativeSources(state, history.borrowReadOnlyRuntimeEntries(), countTokens);
  return { store, host, state, messages, events };
}

export async function commit(
  host: AgentRuntimeInternal,
  state: NativeContextStoredState,
  facts: Pick<NativeContextForkBundle, "operations" | "observations"> = {
    operations: [],
    observations: [],
  },
) {
  await host.sessionStore!.commitNativeContext!(PARENT, {
    expectedRevision: null,
    expectedGeneration: host.branchGeneration,
    state,
    ...facts,
  });
}

export async function rewind(
  host: AgentRuntimeInternal,
  messages: MessageWithParts[],
  keep: number,
) {
  host.branchGeneration += 1;
  await host.sessionStore!.setRevert({
    sessionID: PARENT,
    revert: {
      messageID: messages[Math.min(keep, messages.length - 1)]!.info.id,
      targetMessageID: messages[Math.min(keep, messages.length - 1)]!.info.id,
      keptMessageIDs: messages.slice(0, keep).map((item) => item.info.id),
      branchCutAfterMessageID: messages.at(-1)!.info.id,
      branchGeneration: host.branchGeneration,
    },
  });
  host.messageHistory.reset();
  await hydrateMessageHistoryFromSession({
    history: host.messageHistory,
    messages,
    rewindKeptMessageIds: messages.slice(0, keep).map((item) => item.info.id),
    rewindTargetMessageId: messages[Math.min(keep, messages.length - 1)]!.info.id,
    branchCutAfterMessageId: messages.at(-1)!.info.id,
  });
}

export function refs(state: NativeContextStoredState) {
  return kernelOf(state).compression.messageRefs;
}
