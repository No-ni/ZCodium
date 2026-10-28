import type { WorkspaceAliasPreview } from "../contract.js";
import { candidateKeys, deriveMerge, rowWorkspaceKey } from "./merge.js";
import { textField, type HashPort, type MergePlan, type WorkspaceInspection } from "./images.js";
export function buildPlan(
  input: WorkspaceInspection,
  hash: HashPort,
  now: number,
  ttl: number,
  canonicalOverride?: string,
): MergePlan {
  const candidates = candidateKeys(input);
  const existing = input.aliases.find(
    (alias) =>
      alias.sourceServerId === input.scope.sourceServerId &&
      alias.normalizedPath === input.normalizedPath,
  );
  const canonicalKey =
    existing?.canonicalKey ??
    canonicalOverride ??
    (candidates.length === 1 ? candidates[0]! : input.stableIdentity);
  const all = [...new Set([...candidates, canonicalKey])].sort();
  const derived = deriveMerge(input, canonicalKey, all, hash);
  const blocks: WorkspaceAliasPreview["blocks"] = [...derived.blocks];
  for (const alias of input.aliases)
    if (alias.sourceServerId !== input.scope.sourceServerId && all.includes(alias.canonicalKey))
      blocks.push({ code: "boundary-rejected", subject: "canonical-owned-by-another-source" });
  const excluded = new Set<string>();
  const details = all
    .map((key) => {
      const rows = input.host.tables.flatMap((layout) =>
        layout.rows.filter((row) => rowWorkspaceKey(row, layout.name, input) === key),
      );
      const sessions = input.cli.tables.find((layout) => layout.name === "session");
      const sessionRows = (sessions?.rows ?? []).filter(
        (row) => textField(row, sessions!, "workspace_id") === key,
      );
      const configs = input.configs.filter((value) => value.workspaceKey === key);
      return {
        workspaceKey: key,
        hostRows: rows.length,
        sessionRows: sessionRows.length,
        configEntries: configs.reduce((sum, value) => sum + value.entries.length, 0),
        valueHash: hash.hash({ rows, sessionRows, configs }),
      };
    })
    .filter((value) => candidates.includes(value.workspaceKey));
  for (const layout of input.host.tables)
    for (const row of layout.rows) {
      const key = textField(row, layout, "workspace_key");
      if (key?.startsWith("remote:") && !input.allowedKeys.includes(key)) excluded.add(key);
    }
  const candidateVersion = hash.hash(input);
  const planHash = hash.hash({
    sourceServerId: input.scope.sourceServerId,
    path: input.normalizedPath,
    generation: input.generation,
    canonicalKey,
    candidates,
    collisions: derived.collisions,
    blocks,
    candidateVersion,
  });
  const state = blocks.length
    ? "blocked"
    : existing && candidates.every((key) => key === canonicalKey)
      ? "resolved"
      : candidates.length > 1 || (existing && candidates.some((key) => key !== canonicalKey))
        ? "confirmation-required"
        : candidates.length
          ? "single"
          : "new";
  const preview: WorkspaceAliasPreview = {
    ...input.scope,
    schemaVersion: 1,
    normalizedPath: input.normalizedPath,
    stableIdentity: input.stableIdentity,
    canonicalKey,
    sourceGeneration: input.generation,
    state,
    candidateVersion,
    planHash,
    candidates: details,
    collisions: derived.collisions,
    blocks,
    excludedKeys: [...excluded].sort(),
    createdAt: now,
    expiresAt: now + ttl,
    confirmationToken: "unsigned",
  };
  return {
    inspection: input,
    canonicalKey,
    candidates: all,
    collisions: derived.collisions,
    preview,
  };
}
