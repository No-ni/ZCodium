import { join } from "node:path";
import { isFileSystemPortError } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  formatProjectMemoryIndexContent,
  MEMORY_INDEX_FILE_NAME,
} from "../../memory/index-content.js";
import { type ProjectMemoryRetrievalBranch } from "../../memory/project-memory-retrieval-branch.js";
import { normalizeReadFileStateMtimeMs } from "../../tool/read-file-state.js";
import type { ReadFileStateEntry } from "../../tool/types.js";

export interface ProjectMemoryIndexRead {
  index?: { content: string; readFileStateEntry: ReadFileStateEntry };
  /** 索引文件在但读不出来时的路径；不存在或为空时没有。 */
  unreadablePath?: string;
}

// Memory 索引"不存在"的错误码；其他错误是读不出来，不算删除。
const MISSING_MEMORY_INDEX_ERROR_CODES = new Set(["not_found", "is_directory", "not_file"]);

/** 读取 Memory 索引；读取状态记录由调用方在合适的时机写入。 */
async function readProjectMemoryIndex(
  runtime: AgentRuntimeInternal,
  memoryRoot: string | undefined,
  retrievalBranch: ProjectMemoryRetrievalBranch,
): Promise<ProjectMemoryIndexRead> {
  if (retrievalBranch !== "default-index") return {};
  const fileSystemPort = runtime.fileSystemPort;
  if (!fileSystemPort || !memoryRoot) return {};
  const indexPath = join(memoryRoot, MEMORY_INDEX_FILE_NAME);
  try {
    const read = await fileSystemPort.readTextFile({ path: indexPath });
    const formattedContent = formatProjectMemoryIndexContent(read.content);
    if (!formattedContent) return {};
    return {
      index: {
        content: read.content,
        readFileStateEntry: {
          content: read.content,
          isPartialView: formattedContent !== read.content,
          limit: undefined,
          mtimeMs: normalizeReadFileStateMtimeMs(read.revision?.mtimeMs),
          offset: undefined,
          path: indexPath,
          readAt: runtime.now(),
          revisionId: read.revision?.id,
          seededFromContext: true,
          sizeBytes: read.sizeBytes,
        },
      },
    };
  } catch (error) {
    // 修复原因：读取出错原来一律当成没有索引，权限、占用等错误被宣告成 MEMORY.md 已删除。
    // 只有确实不存在才算没有；其他错误报给调用方，沿用已宣告的内容。
    if (isFileSystemPortError(error) && MISSING_MEMORY_INDEX_ERROR_CODES.has(error.code)) return {};
    return { unreadablePath: indexPath };
  }
}
export { MISSING_MEMORY_INDEX_ERROR_CODES, readProjectMemoryIndex };
