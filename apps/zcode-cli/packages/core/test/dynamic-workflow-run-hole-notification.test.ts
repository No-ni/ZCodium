import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { workflowNotificationMetaSchema } from "@zcode/shared/zcode-protocol-v4";
import { analyzeWorkflowScript } from "@zcode/dynamic-workflow";

import type {
  BackgroundResultOriginMeta,
  DynamicWorkflowRunProgressPayload,
} from "@zcode/contracts";
import type { TraceContext } from "../src/runtime/deps.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  HOLE_REACHED_EVENT_TYPE,
  notifyHoleReached,
} from "../src/runtime/methods/dynamic-workflow-run-hole-notification.js";

/**
 * P2 core：留白通知。纪律是「每条 `hole-reached` 恰好一条模型可见通知；`hole-filled` 不发」，
 * 这里直接对着发射器钉住这两条——不构造整个 AgentRuntime，只给发射器它读的那几样。
 */

interface RecordedNotification {
  text: string;
  taskId?: string;
  originMeta: BackgroundResultOriginMeta;
}

function fakeRuntime(options: { snapshot?: unknown; port?: boolean }): {
  runtime: AgentRuntimeInternal;
  notifications: RecordedNotification[];
} {
  const notifications: RecordedNotification[] = [];
  const runtime = {
    runtimeTaskRegistry: { get: () => ({ description: "My workflow" }) },
    dynamicWorkflowRunPort:
      options.port === false ? undefined : { getTask: async () => options.snapshot },
    logger: { warn: () => {} },
    enqueueBackgroundTaskNotification: (input: RecordedNotification) => {
      notifications.push(input);
    },
  };
  return { runtime: runtime as unknown as AgentRuntimeInternal, notifications };
}

function payload(
  eventType: string,
  body: Record<string, unknown>,
): DynamicWorkflowRunProgressPayload {
  return {
    runId: "dwfrun-1",
    sequence: 7,
    eventType,
    payload: body,
  } as unknown as DynamicWorkflowRunProgressPayload;
}

const trace = {} as TraceContext;

describe("notifyHoleReached", () => {
  it("129-character legal compiled type remains intact while manifest passes shared runtime schema", async () => {
    const type = "T".repeat(129);
    const analysis = analyzeWorkflowScript(
      `type ${type} = string;\nconst x = await hole<${type}>("decide");\nreturn x;`,
    );
    assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
    const { runtime, notifications } = fakeRuntime({
      snapshot: {
        scriptPath: "p".repeat(1025),
        holes: [
          {
            siteId: "hole#12345678",
            ordinal: 1,
            type,
            name: "decide",
            before: "b".repeat(129),
            after: "a".repeat(129),
          },
        ],
      },
    });
    await notifyHoleReached.call(
      runtime,
      payload(HOLE_REACHED_EVENT_TYPE, {
        instance: { siteId: "hole#12345678", ordinal: 1 },
        name: "decide",
      }),
      trace,
    );
    assert.equal(notifications.length, 1);
    const manifest = workflowNotificationMetaSchema.parse(
      notifications[0]!.originMeta.workflowNotification,
    );
    assert.equal(manifest.kind, "hole");
    if (manifest.kind !== "hole") return;
    assert.equal(manifest.type.length, 128);
    assert.equal(manifest.draftPath?.length, 1024);
    assert.equal(manifest.before?.length, 128);
    assert.ok(notifications[0]!.text.includes(type));
  });
  it("每条 hole-reached 恰好一条通知，并念出快照补上的类型与草稿行", async () => {
    const { runtime, notifications } = fakeRuntime({
      snapshot: {
        runStatus: "running",
        scriptPath: "/tmp/plan.dwf.ts",
        holes: [
          {
            siteId: "hole#abc",
            ordinal: 1,
            name: "decide",
            type: "string",
            state: "waiting",
            since: 10,
            line: 3,
            before: "start",
            after: "build",
          },
        ],
      },
    });
    await notifyHoleReached.call(
      runtime,
      payload(HOLE_REACHED_EVENT_TYPE, {
        instance: { siteId: "hole#abc", ordinal: 1 },
        name: "decide",
        prompt: "pick a word",
      }),
      trace,
    );

    assert.equal(notifications.length, 1);
    const [notification] = notifications;
    assert.equal(notification?.taskId, "dwfrun-1");
    assert.match(notification?.text ?? "", /FillWorkflowHole/);
    assert.match(notification?.text ?? "", /hole#abc/);
    assert.match(notification?.text ?? "", /<type>string<\/type>/);
    assert.match(notification?.text ?? "", /\/tmp\/plan\.dwf\.ts/);
    assert.match(notification?.text ?? "", /between phases "start" and "build"/);
    assert.deepEqual(notification?.originMeta.workflowNotification, {
      kind: "hole",
      siteId: "hole#abc",
      ordinal: 1,
      name: "decide",
      type: "string",
      prompt: "pick a word",
      draftPath: "/tmp/plan.dwf.ts",
      line: 3,
      before: "start",
      after: "build",
    });
  });

  it("hole-filled 不发通知", async () => {
    const { runtime, notifications } = fakeRuntime({ snapshot: { holes: [] } });
    await notifyHoleReached.call(
      runtime,
      payload("hole-filled", { siteId: "hole#abc", filledAt: 1 }),
      trace,
    );
    assert.equal(notifications.length, 0);
  });

  it("端口缺席时通知照发，退回载荷自己说得出的字段", async () => {
    const { runtime, notifications } = fakeRuntime({ port: false });
    await notifyHoleReached.call(
      runtime,
      payload(HOLE_REACHED_EVENT_TYPE, {
        instance: { siteId: "hole#abc", ordinal: 1 },
        name: "decide",
      }),
      trace,
    );
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]?.text ?? "", /<type>unknown<\/type>/);
    assert.deepEqual(notifications[0]?.originMeta.workflowNotification, {
      kind: "hole",
      siteId: "hole#abc",
      ordinal: 1,
      name: "decide",
      type: "unknown",
    });
  });

  it("每次到达只有一条 manifest，prompt 同源有界，快照错误不阻止通知", async () => {
    const { runtime, notifications } = fakeRuntime({ port: false });
    for (const ordinal of [1, 2]) {
      await notifyHoleReached.call(
        runtime,
        payload(HOLE_REACHED_EVENT_TYPE, {
          instance: { siteId: "hole#abc", ordinal },
          name: "decide",
          prompt: "x".repeat(5000),
        }),
        trace,
      );
    }
    assert.equal(notifications.length, 2);
    for (const [i, notification] of notifications.entries()) {
      const meta = notification.originMeta.workflowNotification;
      assert.equal(meta?.kind, "hole");
      if (meta?.kind !== "hole") continue;
      assert.equal(meta.ordinal, i + 1);
      assert.equal(meta.prompt?.length, 4000);
      assert.ok(meta.prompt?.endsWith("…"));
      assert.ok(notification.text.includes(meta.prompt!));
    }
  });
});
