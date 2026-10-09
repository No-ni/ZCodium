import { describe, expect, it } from "vitest";
import { createComposerSubmissionConfig } from "./composerSubmissionConfig.js";
import type { ModelSelectionView } from "@zcode/services";

// 编辑重发 / 重试与 sendText 共用同一冻结面：确认那一刻读取 Composer 当前选择。
// 这里固定该函数的契约：无有效选择返回 null（CLI 走 canonical 兜底），
// 有选择时复制叶子并冻结，await 后用户切模不影响已冻结结果。

const view = {
  revision: 1,
  providers: [
    {
      providerId: "zai",
      models: [
        {
          modelId: "glm-4.6",
          config: {
            optionSpecs: { reasoningLevel: { values: ["low", "medium", "high"] } },
          },
        },
      ],
    },
  ],
} as unknown as ModelSelectionView;

describe("composer submission freeze for edit/retry resend", () => {
  it("returns null when no model selection is available", () => {
    expect(createComposerSubmissionConfig({ mode: "build" }, view)).toBeNull();
  });

  it("freezes a copy of the current selection at confirm time", () => {
    const composer = {
      mode: "build",
      planEnabled: false,
      modelSelection: {
        providerId: "zai",
        modelId: "glm-4.6",
        options: { reasoningLevel: "high" },
      },
    };
    const frozen = createComposerSubmissionConfig(composer, view);
    expect(frozen).not.toBeNull();
    expect(frozen?.modelSelection.modelId).toBe("glm-4.6");
    expect(frozen?.modelSelection.options?.reasoningLevel).toBe("high");
    // 冻结后改草稿不影响已返回的 Submission。
    composer.modelSelection = {
      providerId: "zai",
      modelId: "glm-4.7-air",
      options: { reasoningLevel: "low" },
    };
    expect(frozen?.modelSelection.modelId).toBe("glm-4.6");
  });

  it("maps plan mode to build with planEnabled", () => {
    const frozen = createComposerSubmissionConfig(
      {
        mode: "plan",
        planEnabled: true,
        modelSelection: {
          providerId: "zai",
          modelId: "glm-4.6",
          options: { reasoningLevel: "medium" },
        },
      },
      view,
    );
    expect(frozen?.mode).toBe("build");
    expect(frozen?.planEnabled).toBe(true);
  });
});
