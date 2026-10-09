import { describe, expect, it } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { commandPayloadSchemas } from "@zcode/shared/zcode-protocol-v4";
import { inputIntentMetadataFromCanonical } from "./input-intent.js";

// edit/retry 重发的 Submission 选择语义：命令显式携带 > canonical 历史值。
// Renderer 在确认编辑/点击重试瞬间冻结 Composer 当前选择随命令提交；
// 旧发送端缺省时保留历史行为（沿用被编辑轮的原参数）。

function envelopeOf(type: "editUserQuery" | "retryTurn"): CommandEnvelope {
  return {
    commandId: `cmd-${type}`,
    clientId: "renderer",
    sessionId: "session-1",
    baseRevision: 7,
    baseLogEpoch: "epoch-1",
    type,
    payload: undefined,
    issuedAt: 0,
  };
}

const canonicalIntent = {
  kind: "sendText" as const,
  text: "原输入",
  sourceCommandId: "cmd-original",
  clientId: "renderer",
  requestedDelivery: "startNow" as const,
  admittedDelivery: "startNow" as const,
  modelSelection: {
    providerId: "zai",
    modelId: "glm-4.6",
    options: { reasoningLevel: "high" },
  },
  mode: "build" as const,
  planEnabled: false,
};

const override = {
  modelSelection: {
    providerId: "zai",
    modelId: "glm-4.7-air",
    options: { reasoningLevel: "low" },
  },
  mode: "plan" as const,
  planEnabled: true,
};

describe("edit/retry submission 选择覆盖", () => {
  it("payload 携带当前选择时覆盖 canonical 历史参数", () => {
    const intent = inputIntentMetadataFromCanonical(envelopeOf("retryTurn"), {
      ...canonicalIntent,
      ...override,
    });
    expect(intent.modelSelection).toEqual(override.modelSelection);
    expect(intent.mode).toBe("plan");
    expect(intent.planEnabled).toBe(true);
  });

  it("payload 缺省时保留 canonical 历史参数（旧发送端兜底）", () => {
    const intent = inputIntentMetadataFromCanonical(envelopeOf("editUserQuery"), canonicalIntent);
    expect(intent.modelSelection).toEqual(canonicalIntent.modelSelection);
    expect(intent.mode).toBe("build");
    expect(intent.planEnabled).toBe(false);
  });

  it("命令 schema 接受 editUserQuery/retryTurn 的可选 Submission 字段", () => {
    const edit = commandPayloadSchemas.editUserQuery.safeParse({
      target: { rowId: 3, entityId: "entity-3" },
      newText: "改过的输入",
      ...override,
    });
    expect(edit.success).toBe(true);
    const retry = commandPayloadSchemas.retryTurn.safeParse({
      target: { rowId: 3, entityId: "entity-3" },
      ...override,
    });
    expect(retry.success).toBe(true);
  });

  it("命令 schema 仍接受不带 Submission 字段的旧载荷", () => {
    const edit = commandPayloadSchemas.editUserQuery.safeParse({
      target: { rowId: 3, entityId: "entity-3" },
      newText: "改过的输入",
    });
    expect(edit.success).toBe(true);
    const retry = commandPayloadSchemas.retryTurn.safeParse({
      target: { rowId: 3, entityId: "entity-3" },
    });
    expect(retry.success).toBe(true);
  });
});
