export function shouldSyncDataBaseDirDraft(
  previousEffectiveDir: string,
  effectiveDir: string,
  saveState: "idle" | "saving" | "saved" | "error",
): boolean {
  return previousEffectiveDir !== effectiveDir || saveState === "saved";
}
