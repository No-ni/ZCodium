import { buildServerRemoteWorkspaceIdentity, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { WorkspaceAliasError } from "../contract.js";
export function normalizedWorkspacePath(value: string): string {
  if (
    !value ||
    value !== value.trim() ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new WorkspaceAliasError("boundary-rejected");
  const normalized = value.replaceAll("\\", "/").replace(/\/+/g, "/");
  if (
    (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) ||
    normalized.split("/").some((part) => part === "." || part === "..")
  )
    throw new WorkspaceAliasError("boundary-rejected");
  return normalized.startsWith("/")
    ? normalized.replace(/\/$/, "") || "/"
    : `/${normalized.replace(/\/$/, "")}`;
}
export function stableWorkspaceIdentity(sourceServerId: string, workspacePath: string): string {
  normalizedWorkspacePath(workspacePath);
  return buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath });
}
export function verifiedKeys(
  sourceServerId: string,
  workspacePath: string,
  legacy: readonly string[],
): string[] {
  const normalized = normalizedWorkspacePath(workspacePath);
  const stable = stableWorkspaceIdentity(sourceServerId, workspacePath);
  for (const key of legacy) {
    const parsed = parseRemoteWorkspaceIdentity(key);
    if (
      !parsed ||
      parsed.kind === "server" ||
      normalizedWorkspacePath(parsed.workspacePath) !== normalized
    )
      throw new WorkspaceAliasError("boundary-rejected");
  }
  return [...new Set([stable, ...legacy])].sort();
}
export function matchingWorkspacePath(
  value: string | null,
  path: string,
  allowedKeys: readonly string[],
): boolean {
  if (value === null) return false;
  if (allowedKeys.includes(value)) return true;
  try {
    return normalizedWorkspacePath(value) === normalizedWorkspacePath(path);
  } catch {
    return false;
  }
}
