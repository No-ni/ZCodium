import type { WorkspaceFileEntry } from "@zcode/shared";
import * as original from "../../shared/src/workspaceFileEntriesCodec.js";

export const WORKSPACE_FILE_ENTRIES_CHUNK_SIZE = original.WORKSPACE_FILE_ENTRIES_CHUNK_SIZE;
const calls = { pack: 0, unpack: 0 };
if (typeof window !== "undefined") Object.assign(window, { searchCodecCalls: calls });
export function packWorkspaceFileEntries(entries: WorkspaceFileEntry[]) {
  if (typeof window !== "undefined") calls.pack++;
  return original.packWorkspaceFileEntries(entries);
}
export function unpackWorkspaceFileEntries(packed: string, rootPath: string) {
  if (typeof window !== "undefined") calls.unpack++;
  return original.unpackWorkspaceFileEntries(packed, rootPath);
}
