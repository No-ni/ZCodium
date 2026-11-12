import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { initialNativeState } from "../src/runtime/native-context-compression/state.js";
import { appendNativeRequestGuidance } from "../src/runtime/native-context-compression/request-guidance.js";

const runtime = {
  config: {},
  branchGeneration: 0,
  messageHistory: { borrowReadOnlyRuntimeEntries: () => [] },
} as unknown as AgentRuntimeInternal;
const images: RuntimeMessageEntry[] = [
  {
    message: {
      role: "user",
      content: [{ type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,YQ==" }],
    },
  },
];
test("custom image guidance is request-only and independently configurable from visibility markers", () => {
  const state = initialNativeState(runtime);
  state.policy.parameters.prompts.visibilityMarkers = false;
  state.policy.parameters.images.convention.text = "记录合成图片中的按钮颜色。";
  const projected = appendNativeRequestGuidance(images, images, state, null);
  assert.equal(images.length, 1);
  assert.equal(projected.length, 2);
  assert.ok(projected[1]?.kind === "attachment" && projected[1].content.includes("按钮颜色"));
  state.policy.parameters.images.convention.enabled = false;
  assert.equal(appendNativeRequestGuidance(images, images, state, null), images);
});
test("empty image guidance uses the built-in findings and original-retrieval instructions", () => {
  const projected = appendNativeRequestGuidance(images, images, initialNativeState(runtime), null);
  assert.ok(
    projected[1]?.kind === "attachment" &&
      projected[1].content.includes("context_read_image") &&
      projected[1].content.includes("visual findings"),
  );
});
