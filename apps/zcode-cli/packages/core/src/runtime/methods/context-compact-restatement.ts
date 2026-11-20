import { buildEnvironmentAnnouncement } from "../../context/sections/env-info.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import { OUTPUT_STYLE_RESET_REMINDER } from "../helpers/runtime-reminders.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  environmentOf,
  environmentAttachment,
  lastAnnouncedAttachments,
} from "./context-announcement-inputs.js";

/**
 * compaction 重述环境、模型与 output style 指令：
 * 保留段已有完整环境块或同类公告时不重复；否则取 compact 前最近一次公告。
 * 历史里没有时不重述，由下一次请求的输入附件收集补上。
 * 最近一次 output style 公告是重置时不重述。
 */
export function restateContextAfterCompact(
  runtime: AgentRuntimeInternal,
  preCompactEntries: readonly RuntimeMessageEntry[],
  keptEntries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry[] {
  return [
    ...(runtime.latestContextBuildResult?.sections.some((section) => section.source === "env_info")
      ? restateEnvironmentAndModel(preCompactEntries, keptEntries)
      : []),
    ...restateOutputStyle(preCompactEntries, keptEntries),
  ];
}

function restateEnvironmentAndModel(
  preCompactEntries: readonly RuntimeMessageEntry[],
  keptEntries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry[] {
  const attachments: RuntimeAttachmentEntry[] = [];
  if (!keptEntries.some((entry) => environmentOf(entry)?.full)) {
    const snapshot = preCompactEntries
      .map(environmentOf)
      .findLast((value) => value !== undefined)?.snapshot;
    const announcement = snapshot ? buildEnvironmentAnnouncement(snapshot, undefined, false) : null;
    if (announcement) attachments.push(environmentAttachment(announcement));
  }
  const latestModel = lastAnnouncedAttachments(preCompactEntries).get("model");
  if (latestModel && !lastAnnouncedAttachments(keptEntries).has("model")) {
    attachments.push(systemReminderAttachmentEntry("model", latestModel.content));
  }
  return attachments;
}

function restateOutputStyle(
  preCompactEntries: readonly RuntimeMessageEntry[],
  keptEntries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry[] {
  if (lastAnnouncedAttachments(keptEntries).has("output_style_instructions")) return [];
  const latest = lastAnnouncedAttachments(preCompactEntries).get("output_style_instructions");
  return latest && latest.content !== OUTPUT_STYLE_RESET_REMINDER
    ? [systemReminderAttachmentEntry("output_style_instructions", latest.content)]
    : [];
}
export { restateEnvironmentAndModel, restateOutputStyle };
