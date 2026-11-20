import {
  instructionFileRecord,
  parseLegacyInstructionFiles,
} from "../../context/sections/instruction-files.js";
import type { ContextMetaUserAttachment, InstructionAnnouncement } from "../../context/types.js";
import { buildEnvironmentAnnouncement } from "../../context/sections/env-info.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

function fullInstructionAttachment(current: ContextMetaUserAttachment): RuntimeAttachmentEntry {
  return instructionAttachment(current.content, {
    files: (current.files ?? []).map(instructionFileRecord),
  });
}

function announcedInstructionFiles(
  entries: readonly RuntimeMessageEntry[],
): Map<string, InstructionAnnouncement["files"][number]> | undefined {
  const records = entries.filter(
    (entry): entry is RuntimeAttachmentEntry =>
      entry.kind === "attachment" && entry.metadata.source === "context_prefix",
  );
  const fullIndex = records.findLastIndex((record) => !record.metadata.instructions?.reason);
  if (fullIndex === -1) return undefined;
  const files = new Map<string, InstructionAnnouncement["files"][number]>();
  for (const record of records.slice(fullIndex)) {
    // 旧记录没有 metadata，只可能是完整公告；按标题行拆出文件。
    const announcement = record.metadata.instructions ?? {
      files: parseLegacyInstructionFiles(record.content),
    };
    for (const file of announcement.files) files.set(file.path, file);
    for (const path of announcement.removed ?? []) files.delete(path);
  }
  return files;
}

function instructionAttachment(
  content: string,
  instructions: InstructionAnnouncement,
): RuntimeAttachmentEntry {
  return {
    ...systemReminderAttachmentEntry("context_prefix", content),
    metadata: { source: "context_prefix", instructions },
  };
}

// 已恢复和克隆的条目在 hydrate / clone 时校验过 environment 元数据，这里直接读取。
function environmentOf(entry: RuntimeMessageEntry | undefined) {
  return entry?.kind === "attachment" && entry.metadata.source === "environment"
    ? entry.metadata.environment
    : undefined;
}

/** 历史中最近一次环境公告的快照。 */
export function latestAnnouncedEnvironment(entries: readonly RuntimeMessageEntry[]) {
  return environmentOf(lastAnnouncedAttachments(entries).get("environment"))?.snapshot;
}

function environmentAttachment(
  announcement: NonNullable<ReturnType<typeof buildEnvironmentAnnouncement>>,
): RuntimeAttachmentEntry {
  return {
    ...systemReminderAttachmentEntry("environment", announcement.content),
    metadata: { source: "environment", environment: announcement.environment },
  };
}

function lastAnnouncedAttachments(
  entries: readonly RuntimeMessageEntry[],
): Map<string, RuntimeAttachmentEntry> {
  const last = new Map<string, RuntimeAttachmentEntry>();
  for (const entry of entries) {
    if (entry.kind === "attachment") last.set(entry.metadata.source, entry);
  }
  return last;
}
export {
  fullInstructionAttachment,
  announcedInstructionFiles,
  instructionAttachment,
  environmentOf,
  environmentAttachment,
  lastAnnouncedAttachments,
};
