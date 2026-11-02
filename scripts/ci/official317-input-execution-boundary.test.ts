import assert from "node:assert/strict";
import test from "node:test";
import { modelExecutionSchema } from "@zcode/shared";

test("普通单轮执行约束可用，输入命令不接纳官方票据或退回材料", () => {
  const ordinary = {
    selectionScope: "execution",
    memoryExtraction: "skip",
    subagents: { foregroundModel: "submission", background: "deny" },
  };
  assert.deepEqual(modelExecutionSchema.parse(ordinary), ordinary);
  for (const field of [
    { requestAuth: { apiKey: "synthetic-ticket" } },
    {
      offPeak: {
        executionId: "legacy-execution",
        ticketId: "legacy-ticket",
        providerErrorCode: "legacy-code",
      },
    },
    {
      selectionFallback: {
        providerId: "legacy-provider",
        rules: [{ reason: "highspeed_card_expired" }],
      },
    },
  ]) {
    assert.equal(modelExecutionSchema.safeParse({ ...ordinary, ...field }).success, false);
  }
});
