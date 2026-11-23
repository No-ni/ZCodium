import { expect, it } from "vitest";
import { redactAnthropicRequestMetadata } from "../src/model/anthropic-request-metadata.js";

// 归因生成已退役，历史诊断的脱敏仍是本仓边界。
it("redacts device attribution from model I/O debug payloads", () => {
    expect(
      redactAnthropicRequestMetadata({
        metadata: { user_id: "wire-device-and-session" },
      }),
    ).toEqual({
      metadata: { user_id: "[REDACTED]" },
    });
    expect(
      redactAnthropicRequestMetadata({
        providerOptions: {
          anthropic: {
            effort: "high",
            metadata: { userId: "options-device-and-session" },
          },
        },
      }),
    ).toEqual({
      providerOptions: {
        anthropic: {
          effort: "high",
          metadata: { userId: "[REDACTED]" },
        },
      },
    });
  });
