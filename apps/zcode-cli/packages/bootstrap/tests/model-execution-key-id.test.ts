import { describe, expect, it } from "vitest";
import { zcodeSessionSendParamsSchema } from "@zcode/shared";

describe("请求期 Key ID 执行上下文", () => {
  it("在协议准入前拒绝退役的官方账号鉴权材料", () => {
    const requestAuth = { apiKey: "pat", apiKeyId: "real-key-id", accountScope: "a".repeat(64) };
    const parsed =
      zcodeSessionSendParamsSchema.shape.modelExecution
        .unwrap()
        .safeParse({ selectionScope: "execution", requestAuth });
    expect(parsed.success).toBe(false);
  });

  it("在协议准入前拒绝退役的套餐退回声明", () => {
    // 退回目标必须完整到达 core：冷恢复竞态下 runtime 可能没有常驻选择，这是唯一的退回依据。
    const selectionFallback = {
      providerId: "account:bigmodel-highspeed-card",
      rules: [
        { reason: "highspeed_card_expired" as const, providerErrorCode: "3402" },
        { reason: "highspeed_request_failed" as const },
      ],
      target: {
        providerId: "account:bigmodel-team-coding-plan",
        modelId: "GLM-5.3",
        options: { reasoningLevel: "low" },
      },
    };
    const parsed =
      zcodeSessionSendParamsSchema.shape.modelExecution
        .unwrap()
        .safeParse({ selectionScope: "execution", selectionFallback });
    expect(parsed.success).toBe(false);
  });
});
