import { boundDynamicWorkflowRunEventPayload } from "./contract.js";
import type { BrowserRecordingOptions } from "./contract.js";

/** 裁剪结果用于协议观察面；原始事实仍由既有 journal owner 保存。 */
export function prepareProgress(payload: Record<string, unknown>) {
  return boundDynamicWorkflowRunEventPayload(payload);
}

export const recordingExample: BrowserRecordingOptions = {
  viewport: { width: 1280, height: 720 },
  actions: [{ type: "wait", durationMs: 250 }],
};
