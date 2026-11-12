import type { NativeContextIdentity, NativeContextObservation } from "../contract.js";

export function nativeContextScopeKey(identity: NativeContextIdentity): string {
  return JSON.stringify([
    identity.workspaceIdentity?.trim() || identity.workspacePath,
    identity.remoteSessionId ?? null,
    identity.sessionId,
  ]);
}

export function formatContextNumber(value: number | null | undefined, locale: string): string {
  return value == null
    ? "—"
    : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

export function formatContextBytes(value: number | null | undefined, locale: string): string {
  if (value == null) return "—";
  if (value < 1024) return `${formatContextNumber(value, locale)} B`;
  const unit = value < 1024 * 1024 ? "KiB" : "MiB";
  const divisor = unit === "KiB" ? 1024 : 1024 * 1024;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / divisor)} ${unit}`;
}

export function nativeContextRequestSaving(observation: NativeContextObservation): number | null {
  return observation.measurementScope !== "complete" ||
    observation.beforeEstimate === null ||
    observation.afterEstimate === null
    ? null
    : observation.beforeEstimate - observation.afterEstimate;
}

export function nativeContextVersionKey(value: {
  revision: number;
  generation: number;
  historyVersion: string;
}): string {
  return JSON.stringify([value.revision, value.generation, value.historyVersion]);
}
