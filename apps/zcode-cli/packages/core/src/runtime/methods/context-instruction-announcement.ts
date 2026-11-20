import {
  instructionFileRecord,
  renderInstructionDelta,
} from "../../context/sections/instruction-files.js";
import type {
  ContextBuildResult,
  ContextMetaUserAttachment,
  InstructionRefreshReason,
} from "../../context/types.js";
import { type RuntimeAttachmentEntry } from "../../agent/message-history.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  fullInstructionAttachment,
  announcedInstructionFiles,
  instructionAttachment,
} from "./context-announcement-inputs.js";

function currentInstructions(
  result: ContextBuildResult | undefined,
): ContextMetaUserAttachment | undefined {
  return result?.metaUserAttachments.find((item) => item.source === "context_prefix");
}

/**
 * 指令公告（指令文件与 Memory 索引）发出后不改写，变化在末尾追加增量。
 * 已公告的文件只从历史推出：最后一条完整公告，再按顺序套用之后的增量（files 覆盖同路径，removed 删除）。
 * 当前文件来自 runtime 最近一次构建（启动时与 compaction 提交后读取）。历史里没有完整公告时发完整公告；
 * 有变化或新增的文件、或已公告的文件不再存在时，追加一条增量；全部相同时不发。
 * 修复原因：原来冷恢复与 rewind 时把历史里的指令公告原位改成当前内容，已发送的前缀字节改变，
 * prompt cache 失效，也会让 provider 对已绑定前缀的 thinking 签名校验失败。
 */
function buildInstructionAnnouncement(
  current: ContextMetaUserAttachment | undefined,
  entries: readonly RuntimeMessageEntry[],
  reason: InstructionRefreshReason,
  unreadable: ReadonlySet<string> = new Set(),
): RuntimeAttachmentEntry | undefined {
  const announced = announcedInstructionFiles(entries);
  if (!announced) return current ? fullInstructionAttachment(current) : undefined;
  const currentFiles = current?.files ?? [];
  const changed = currentFiles.filter((file) => {
    const previous = announced.get(file.path);
    const record = instructionFileRecord(file);
    return !previous || previous.hash !== record.hash || previous.type !== record.type;
  });
  // 读不出来的文件不算删除，模型保留已宣告的副本。
  const removed = [...announced.keys()].filter(
    (path) => !unreadable.has(path) && !currentFiles.some((file) => file.path === path),
  );
  if (changed.length === 0 && removed.length === 0) return undefined;
  return instructionAttachment(renderInstructionDelta(changed, removed, reason), {
    files: changed.map(instructionFileRecord),
    ...(removed.length > 0 ? { removed } : {}),
    reason,
  });
}
export { currentInstructions, buildInstructionAnnouncement };
