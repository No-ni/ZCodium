import type { WorkspaceAliasCollision, WorkspaceAliasPreview } from "../contract.js";
export type Cell = null | string | number | { integer: string } | { blob: string };
export interface TableImage {
  name: string;
  sql: string;
  columns: string[];
  insertColumns: string[];
  primaryKey: string[];
  rowidColumn: string | null;
  rows: Cell[][];
}
export interface DatabaseImage {
  exists: boolean;
  identity: string;
  schema: string;
  tables: TableImage[];
}
export interface DatabaseJournalImage {
  databaseIdentity: string;
  databaseHash: string;
  journalIdentity: string;
  journalHash: string;
}
export interface ConfigImage {
  root: string;
  workspaceKey: string;
  directory: string;
  exists: boolean;
  entries: Array<{ path: string; kind: "directory" | "file"; content?: string; hash: string }>;
}
export interface AliasImage {
  sourceServerId: string;
  normalizedPath: string;
  canonicalKey: string;
  jobId: string;
}
export interface WorkspaceInspection {
  scope: { sourceServerId: string; workspacePath: string };
  normalizedPath: string;
  stableIdentity: string;
  generation: number;
  rootGeneration: string;
  projectId: string;
  allowedKeys: string[];
  host: DatabaseImage;
  cli: DatabaseImage;
  configs: ConfigImage[];
  aliases: AliasImage[];
}
export interface MergePlan {
  inspection: WorkspaceInspection;
  canonicalKey: string;
  candidates: string[];
  collisions: WorkspaceAliasCollision[];
  preview: WorkspaceAliasPreview;
}
export interface MergeOutput {
  host: DatabaseImage;
  cli: DatabaseImage;
  configs: ConfigImage[];
}
export interface HashPort {
  hash(value: unknown): string;
}
export function table(image: DatabaseImage, name: string): TableImage | undefined {
  return image.tables.find((value) => value.name === name);
}
export function field(row: Cell[], layout: TableImage, name: string): Cell | undefined {
  return row[layout.columns.indexOf(name)];
}
export function textField(row: Cell[], layout: TableImage, name: string): string | null {
  const value = field(row, layout, name);
  return typeof value === "string" ? value : null;
}
export function setField(row: Cell[], layout: TableImage, name: string, value: Cell): void {
  const position = layout.columns.indexOf(name);
  if (position >= 0) row[position] = value;
}
