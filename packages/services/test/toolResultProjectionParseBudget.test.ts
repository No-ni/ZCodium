import assert from "node:assert/strict";
import test from "node:test";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import type { ZCodeStreamEvent } from "@zcode/shared";

/**
 * 工具结果投影的解析预算回归（真实 adapter 入口 + 全 stub 依赖，无 IO）。
 *
 * Bug 原因：mapToolUpdated 的 result 分支顺序调用 normalizeToolResultContent
 * （经 parseAgentActivityResultContent → parseJsonRecord）与 toolResultStatus
 * （经 isBackgroundAgentLaunchResult → parseJsonRecord）；两个解析互不复用，
 * 同一个 tool_call_update 事件把同一份 result.content 全量 JSON.parse 两次。
 * JSON 文本 content（Read 到 .json、MCP JSON 输出、Agent/Task 结果）每次事件
 * 都白付一次全量 parse；纯文本则两次快速失败。
 *
 * 修复依据：两个消费方都只读取解析结果的对象字段，且都在本事件内用完。
 * 在 result 分支内解析一次（仅当 content 是非空字符串时才 parse，与两个消费方
 * 既有的前置守卫逐字一致）并以可选参数传入，判定输入与顺序不变，投影输出逐位一致。
 *
 * 测试全程 hermetic：假 zcodeAgentService / taskIndexRepo / taskIndexSyncer，
 * 不写文件系统、不启动 Agent、不使用真实用户数据；JSON.parse 计数只统计
 * 与目标 content 同一字符串的调用，测试结束后还原。
 */

const TASK_ID = "parse-budget-task";
const WORKSPACE_PATH = "/synthetic/workspace";

const meta = {
  taskId: TASK_ID,
  traceId: "trace-parse-budget",
  title: "parse budget",
  workspacePath: WORKSPACE_PATH,
  createdAt: 1,
  updatedAt: 2,
  mode: "build" as const,
  provider: "glm" as const,
  model: "model-a",
  thoughtLevel: "high" as const,
  status: "running" as const,
};

const disposable = () => ({ dispose() {} });

interface Harness {
  events: ZCodeStreamEvent[];
  fireToolResult(payload: Record<string, unknown>): void;
  dispose(): void;
}

function createHarness(): Harness {
  let sessionListener: ((event: unknown) => void) | null = null;
  const events: ZCodeStreamEvent[] = [];
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      onDynamicSessionEvent: () => (listener: (event: unknown) => void) => {
        sessionListener = listener;
        return disposable();
      },
      disposeAll() {},
    } as unknown as Parameters<typeof createZCodeTaskServiceAdapter>[0]["zcodeAgentService"],
    taskIndexRepo: {
      close() {},
      async applyAgentPatch() {
        return meta;
      },
      async getTaskMeta() {
        return meta;
      },
      async updateTaskState() {
        return meta;
      },
      async seedTaskMetaIfMissing() {
        return meta;
      },
    } as unknown as Parameters<typeof createZCodeTaskServiceAdapter>[0]["taskIndexRepo"],
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      onDynamicWorkspaceEvent: disposable,
      ensureSessionSubscription() {},
      disposeAll() {},
    } as unknown as Parameters<typeof createZCodeTaskServiceAdapter>[0]["taskIndexSyncer"],
  });
  service.onDynamicTaskEvent({
    taskId: TASK_ID,
    workspacePath: WORKSPACE_PATH,
    deliveryKind: "desktop-continuous",
  })((event) => events.push(event));
  return {
    events,
    fireToolResult(payload) {
      sessionListener?.({
        type: "session.event",
        event: {
          type: "tool.updated",
          sessionId: TASK_ID,
          timestamp: 1,
          payload,
        },
      });
    },
    dispose() {
      service.disposeAll();
    },
  };
}

/** 统计对目标 content 字符串的 JSON.parse 调用次数（同一引用，计数精确）。 */
function countContentParses(content: string, run: () => void): number {
  // 保存原函数引用（不 bind）：finally 还原同一 identity，避免逐次叠加 wrapper。
  const realParse = JSON.parse;
  let count = 0;
  (JSON as { parse: typeof JSON.parse }).parse = ((text: string, reviver?: unknown) => {
    if (text === content) count += 1;
    return realParse(text, reviver as never);
  }) as typeof JSON.parse;
  try {
    run();
  } finally {
    (JSON as { parse: typeof JSON.parse }).parse = realParse;
  }
  return count;
}

/** 统计全部 JSON.parse 调用次数（用于断言“根本不触发解析”的场景）。 */
function countAllParses(run: () => void): number {
  // 保存原函数引用（不 bind）：finally 还原同一 identity，避免逐次叠加 wrapper。
  const realParse = JSON.parse;
  let count = 0;
  (JSON as { parse: typeof JSON.parse }).parse = ((value: string, reviver?: unknown) => {
    count += 1;
    return realParse(value, reviver as never);
  }) as typeof JSON.parse;
  try {
    run();
  } finally {
    (JSON as { parse: typeof JSON.parse }).parse = realParse;
  }
  return count;
}

function fireAndCount(harness: Harness, content: string, payload: Record<string, unknown>): number {
  return countContentParses(content, () => {
    harness.fireToolResult(payload);
  });
}

const AGENT_RESULT_CONTENT = JSON.stringify({
  agentId: "agent-1",
  agentType: "general",
  content: [{ type: "text", text: "subagent finished" }],
  thought: "thinking through the task",
});

const BACKGROUND_JSON_CONTENT = JSON.stringify({
  status: "backgrounded",
  backgroundTaskId: "bg-task-1",
});

const BACKGROUND_ACK_CONTENT = [
  "Async agent launched successfully.",
  "agentId: agent-7",
  "Output file: out.json",
  "The agent is working in the background.",
  "You will be notified automatically when it completes.",
].join("\n");

test("Read 工具的大 JSON 结果只解析一次且投影不变", () => {
  const harness = createHarness();
  try {
    const jsonContent = JSON.stringify({
      files: Array.from({ length: 4000 }, (_, index) => ({
        path: `src/module-${index}.ts`,
        bytes: index * 97,
      })),
    });
    const parseCount = fireAndCount(harness, jsonContent, {
      kind: "result",
      toolCallId: "tool-json",
      toolName: "Read",
      duration: 1,
      result: { success: true, content: jsonContent },
    });
    assert.equal(parseCount, 1, "同一份 JSON content 在每个投影事件里只能解析一次");
    assert.equal(harness.events.length, 1);
    const event = harness.events[0] as Record<string, unknown>;
    assert.equal(event.type, "tool_call_update");
    assert.equal(event.toolName, "Read");
    assert.equal(event.status, "completed");
    assert.equal(event.content, jsonContent, "JSON content 仍按原字符串投影");
  } finally {
    harness.dispose();
  }
});

test("纯文本工具结果只尝试解析一次且投影不变", () => {
  const harness = createHarness();
  try {
    const textContent = `line ${"x".repeat(200_000)}`;
    const parseCount = fireAndCount(harness, textContent, {
      kind: "result",
      toolCallId: "tool-text",
      toolName: "Bash",
      duration: 1,
      result: { success: true, content: textContent },
    });
    assert.equal(parseCount, 1, "纯文本 content 每个事件只允许一次（快速失败的）解析尝试");
    const event = harness.events[0] as Record<string, unknown>;
    assert.equal(event.status, "completed");
    assert.equal(event.content, textContent);
  } finally {
    harness.dispose();
  }
});

test("Agent JSON 结果仍投影为 agent_activity 且只解析一次", () => {
  const harness = createHarness();
  try {
    const parseCount = fireAndCount(harness, AGENT_RESULT_CONTENT, {
      kind: "result",
      toolCallId: "tool-agent",
      toolName: "Agent",
      duration: 1,
      result: { success: true, content: AGENT_RESULT_CONTENT },
    });
    assert.equal(parseCount, 1);
    const event = harness.events[0] as Record<string, unknown>;
    assert.equal(event.status, "completed");
    assert.deepEqual(event.content, {
      kind: "agent_activity",
      content: "subagent finished",
      thought: "thinking through the task",
    });
  } finally {
    harness.dispose();
  }
});

test("后台启动 ACK 文本仍判为 in_progress 且只解析一次", () => {
  const harness = createHarness();
  try {
    const parseCount = fireAndCount(harness, BACKGROUND_ACK_CONTENT, {
      kind: "result",
      toolCallId: "tool-ack",
      toolName: "Agent",
      duration: 1,
      result: { success: true, content: BACKGROUND_ACK_CONTENT },
    });
    assert.equal(parseCount, 1);
    const event = harness.events[0] as Record<string, unknown>;
    assert.equal(event.status, "in_progress", "后台启动 ACK 不得被投影成 completed");
    assert.equal(event.content, BACKGROUND_ACK_CONTENT);
  } finally {
    harness.dispose();
  }
});

test("后台启动 JSON 结果仍判为 in_progress 且只解析一次（锁住经解析分支的判定）", () => {
  const harness = createHarness();
  try {
    const parseCount = fireAndCount(harness, BACKGROUND_JSON_CONTENT, {
      kind: "result",
      toolCallId: "tool-bg-json",
      toolName: "Agent",
      duration: 1,
      result: { success: true, content: BACKGROUND_JSON_CONTENT },
    });
    assert.equal(parseCount, 1);
    const event = harness.events[0] as Record<string, unknown>;
    assert.equal(event.status, "in_progress", "backgrounded JSON 判定必须仍拿到复用的解析结果");
  } finally {
    harness.dispose();
  }
});

test("空串 content 不触发解析且投影为 undefined", () => {
  const harness = createHarness();
  try {
    const allParses = countAllParses(() => {
      harness.fireToolResult({
        kind: "result",
        toolCallId: "tool-empty",
        toolName: "Bash",
        duration: 1,
        result: { success: true, content: "" },
      });
    });
    assert.equal(allParses, 0, "空串 content 不得触发 JSON.parse");
    const event = harness.events[0] as Record<string, unknown>;
    assert.equal(event.status, "completed");
    assert.equal(event.content, undefined, "空串 content 投影为 undefined（stringValue 语义）");
  } finally {
    harness.dispose();
  }
});

test("非字符串 content 不触发解析且投影为 undefined", () => {
  const harness = createHarness();
  try {
    for (const content of [12345, { nested: "object" }, undefined, null]) {
      harness.events.length = 0;
      let allParses = -1;
      allParses = countAllParses(() => {
        harness.fireToolResult({
          kind: "result",
          toolCallId: `tool-nonstring-${typeof content}`,
          toolName: "Bash",
          duration: 1,
          result: { success: true, content },
        });
      });
      assert.equal(allParses, 0, `非字符串 content（${typeof content}）不得触发 JSON.parse`);
      const event = harness.events[0] as Record<string, unknown>;
      assert.equal(event.status, "completed");
      assert.equal(event.content, undefined);
    }
  } finally {
    harness.dispose();
  }
});

test("Read 带 agentId 且含 content 的 JSON 保持 agent_activity 投影且只解析一次", () => {
  const harness = createHarness();
  try {
    const content = JSON.stringify({
      agentId: "agent-9",
      content: "extracted summary text",
    });
    const parseCount = fireAndCount(harness, content, {
      kind: "result",
      toolCallId: "tool-mis-with",
      toolName: "Read",
      duration: 1,
      result: { success: true, content },
    });
    assert.equal(parseCount, 1);
    const event = harness.events[0] as Record<string, unknown>;
    assert.equal(event.status, "completed");
    assert.deepEqual(
      event.content,
      {
        kind: "agent_activity",
        content: "extracted summary text",
      },
      "agentId 归一本轮不收窄：保持现有 agent_activity 投影",
    );
  } finally {
    harness.dispose();
  }
});

test("Read 带 agentId 但不含 content 的 JSON 回落原文字符串且只解析一次", () => {
  const harness = createHarness();
  try {
    const content = JSON.stringify({ agentId: "agent-9", note: "no content field" });
    const parseCount = fireAndCount(harness, content, {
      kind: "result",
      toolCallId: "tool-mis-without",
      toolName: "Read",
      duration: 1,
      result: { success: true, content },
    });
    assert.equal(parseCount, 1);
    const event = harness.events[0] as Record<string, unknown>;
    assert.equal(event.status, "completed");
    assert.equal(event.content, content, "无可提取 content 时回落原始 JSON 字符串");
  } finally {
    harness.dispose();
  }
});

test("async_launched JSON 仍判为 in_progress 且只解析一次（经解析分支）", () => {
  const harness = createHarness();
  try {
    const content = JSON.stringify({
      status: "async_launched",
      agentId: "agent-1",
      outputFile: "out.txt",
    });
    const parseCount = fireAndCount(harness, content, {
      kind: "result",
      toolCallId: "tool-async",
      toolName: "Agent",
      duration: 1,
      result: { success: true, content },
    });
    assert.equal(parseCount, 1);
    const event = harness.events[0] as Record<string, unknown>;
    assert.equal(event.status, "in_progress", "async_launched 判定必须仍拿到复用的解析结果");
  } finally {
    harness.dispose();
  }
});

test("legacy/previous 后台启动 ACK 变体仍判为 in_progress 且只解析一次", () => {
  const harness = createHarness();
  try {
    const variants = [
      "backgroundTaskId: bg-1\nRuntime will wait for this background Agent",
      "Agent explorer started in background.\nagentId: agent-1\noutputFile: out.txt\nYou will be notified when the Agent completes.",
    ];
    for (const [index, content] of variants.entries()) {
      harness.events.length = 0;
      const parseCount = fireAndCount(harness, content, {
        kind: "result",
        toolCallId: `tool-ack-variant-${index}`,
        toolName: "Agent",
        duration: 1,
        result: { success: true, content },
      });
      assert.equal(parseCount, 1);
      const event = harness.events[0] as Record<string, unknown>;
      assert.equal(event.status, "in_progress", `ACK 变体 ${index} 不得被投影成 completed`);
    }
  } finally {
    harness.dispose();
  }
});

test("scheduled 事件播种的记忆工具名驱动结果投影且只解析一次", () => {
  const harness = createHarness();
  try {
    harness.fireToolResult({
      kind: "scheduled",
      toolCallId: "tool-seeded",
      toolName: "Agent",
      input: { prompt: "do work" },
    });
    const parseCount = fireAndCount(harness, AGENT_RESULT_CONTENT, {
      kind: "result",
      toolCallId: "tool-seeded",
      duration: 1,
      result: { success: true, content: AGENT_RESULT_CONTENT },
    });
    assert.equal(parseCount, 1);
    const update = harness.events.at(-1) as Record<string, unknown>;
    assert.equal(update.type, "tool_call_update");
    assert.equal(update.toolName, "Agent", "无 toolName 的 result 必须复用 scheduled 播种的记忆名");
    assert.deepEqual(update.content, {
      kind: "agent_activity",
      content: "subagent finished",
      thought: "thinking through the task",
    });
  } finally {
    harness.dispose();
  }
});

test("success:false 仍判为 failed 且只解析一次", () => {
  const harness = createHarness();
  try {
    const failureContent = "tool execution failed";
    const parseCount = fireAndCount(harness, failureContent, {
      kind: "result",
      toolCallId: "tool-failed",
      toolName: "Bash",
      duration: 1,
      result: { success: false, content: failureContent },
    });
    assert.equal(parseCount, 1);
    const event = harness.events[0] as Record<string, unknown>;
    assert.equal(event.status, "failed");
    assert.equal(event.content, failureContent);
  } finally {
    harness.dispose();
  }
});
