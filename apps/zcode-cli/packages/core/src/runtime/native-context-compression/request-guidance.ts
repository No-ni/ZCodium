import { activeBlocks } from "acp-kernel";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { nativeMaintenanceRanges } from "./candidates.js";
import { kernelOf } from "./state.js";

export function appendNativeRequestGuidance(
  projected: RuntimeMessageEntry[],
  original: readonly RuntimeMessageEntry[],
  state: NativeContextStoredState,
  inputBudget: number | null,
): RuntimeMessageEntry[] {
  const blocks = activeBlocks(kernelOf(state).compression);
  const ranges = inputBudget
    ? nativeMaintenanceRanges(original, state, inputBudget).slice(0, 20)
    : [];
  const showContext =
    state.policy.parameters.prompts.visibilityMarkers &&
    Boolean(blocks.length || ranges.length || Object.keys(kernelOf(state).views).length);
  const convention = state.policy.parameters.images.convention;
  const hasImages =
    state.sources.some((source) => source.kind === "image") ||
    original.some(
      (entry) =>
        entry.kind !== "attachment" &&
        Array.isArray(entry.message.content) &&
        entry.message.content.some((block) => block.type === "image"),
    );
  // 图片指导是独立可调提示；必要的原图来源与发送证明仍由图片投影强制维护。
  const imageGuidance =
    convention.enabled && hasImages
      ? convention.text.trim() ||
        "Inspect provided images only when needed for the task. Record relevant visual findings in the response so later context can retain them. Images may be resized or replaced by recoverable refs; use context_read_image to inspect the immutable original when finer detail is needed. Never claim to have seen an image that was not provided."
      : undefined;
  if (!showContext && !imageGuidance) return projected;
  const text = [
    ...(showContext
      ? [
          "Recoverable native context: summaries and references retain original sources in this task. Use context_search and bounded context_read pages when detail is needed; context_read_image returns an original image for one request.",
        ]
      : []),
    ...(showContext && ranges.length
      ? [
          `Only these complete ranges may be passed to context_compress: ${ranges.map((range) => `${range.startRef}..${range.endRef}`).join(", ")}. Preserve goals, decisions, exact identifiers and unfinished work. The current input and protected exchanges remain outside these ranges.`,
        ]
      : []),
    ...(imageGuidance ? [imageGuidance] : []),
  ].join("\n");
  return [...projected, systemReminderAttachmentEntry("prompt_attachment", text)];
}
