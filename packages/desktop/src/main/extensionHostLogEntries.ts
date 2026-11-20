import {
  truncateExtensionLogMessage,
  type ExtensionLogEntry,
  type ExtensionLogLevel,
} from "@zcode/shared/extension-host";

/** 只派生记录和只读切片；序号、缓冲与发布资格继续由 supervisor 持有。 */
export function createExtensionLogEntry(
  seq: number,
  gen: number,
  level: ExtensionLogLevel,
  message: string,
  pluginId?: string,
): ExtensionLogEntry {
  return {
    seq,
    ts: Date.now(),
    level,
    gen,
    ...(pluginId ? { pluginId } : {}),
    message: truncateExtensionLogMessage(message),
  };
}

export function readExtensionLogSnapshot(
  entries: readonly ExtensionLogEntry[],
  lastSeq: number,
  sinceSeq?: number,
) {
  const firstSeq = entries[0]?.seq ?? lastSeq + 1;
  return {
    entries:
      sinceSeq === undefined ? [...entries] : entries.slice(Math.max(0, sinceSeq - firstSeq + 1)),
    lastSeq,
  };
}
