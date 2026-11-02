import { describe, expect, it } from "vitest";
import { isAmendWorkflowOwnedPredecessor, AmendWorkflowInputSchema } from "../src/tools/amend-workflow.js";
import { CreateWorkflowInputSchema, CreateWorkflowOutputSchema } from "../src/tools/create-workflow.js";

describe("官方 3.17.1 工作流融合边界", () => {
  it("本会话的前驱引入新 provider 时仍需确认", () => {
    expect(isAmendWorkflowOwnedPredecessor({ owned_by_this_session: true })).toBe(true);
    expect(isAmendWorkflowOwnedPredecessor({ owned_by_this_session: true, stop_reason: "user" })).toBe(false);
    expect(isAmendWorkflowOwnedPredecessor({ owned_by_this_session: true, introduces_providers: ["other"] })).toBe(false);
  });

  it("补全输出保留 durable journal 顺序及路径边界", () => {
    const output = { ok: true, response: "filled", diagnostics: [], fill: { siteId: "hole", name: "next", commitSequence: 12, draftPath: "draft.ts" } };
    expect(CreateWorkflowOutputSchema.parse(output).fill?.commitSequence).toBe(12);
    expect(CreateWorkflowOutputSchema.safeParse({ ...output, fill: { ...output.fill, draftPath: "x".repeat(1025) } }).success).toBe(false);
  });

  it("并发默认值与用户上界分别保存", () => {
    const output = CreateWorkflowOutputSchema.parse({ ok: true, response: "retuned", diagnostics: [], retuned: { runId: "run", previous: 2, maxConcurrency: 8, defaultConcurrency: 4 } });
    expect(output.retuned).toEqual({ runId: "run", previous: 2, maxConcurrency: 8, defaultConcurrency: 4 });
  });

  it("绑定表沿用有界 schema", () => {
    const bindings = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`name${index}`, "provider/model"]));
    expect(CreateWorkflowInputSchema.shape.model_bindings.safeParse(bindings).success).toBe(false);
    expect(AmendWorkflowInputSchema.shape.model_bindings.safeParse(bindings).success).toBe(false);
  });
});
