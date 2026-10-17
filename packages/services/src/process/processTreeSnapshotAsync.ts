import type { ChildProcess } from "node:child_process";
import { collectProcessDescendants } from "#src/process/processTreeTraversal.js";
import {
  captureExitedRootDescendantsSnapshot,
  captureProcessTreeSnapshot,
  filterCurrentProcessIdentities,
} from "#src/process/processTreeSnapshot.js";
import type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";
import { readWindowsProcessListAsync } from "#src/process/windowsProcessListAsync.js";

export { verifyWindowsProcessIdentityAsync } from "#src/process/windowsProcessListAsync.js";

const WINDOWS_START_TIME_PREFIX = "windows-utc-us:";

function parseWindowsCreationTimeMs(startTime: string): number | undefined {
  if (!startTime.startsWith(WINDOWS_START_TIME_PREFIX)) return undefined;
  try {
    const microseconds = BigInt(startTime.slice(WINDOWS_START_TIME_PREFIX.length));
    const timestamp = Number(microseconds / 1_000n);
    return Number.isSafeInteger(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

export async function filterCurrentProcessIdentitiesAsync(
  identities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): Promise<ProcessIdentity[]> {
  if (process.platform !== "win32") {
    return filterCurrentProcessIdentities(identities, options);
  }
  if (identities.length === 0) return [];
  const trackedPids = new Set(identities.map((identity) => identity.pid));
  const currentByPid = new Map(
    (await readWindowsProcessListAsync(options))
      .filter((identity) => trackedPids.has(identity.pid))
      .map((identity) => [identity.pid, identity]),
  );
  return identities.filter((identity) => {
    const current = currentByPid.get(identity.pid);
    return current?.startTime === identity.startTime;
  });
}

export async function captureProcessTreeSnapshotAsync(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): Promise<ProcessTreeSnapshot | undefined> {
  if (process.platform !== "win32") return captureProcessTreeSnapshot(child, options);
  if (child.pid == null) return undefined;
  const processList = await readWindowsProcessListAsync(options);
  const childExitedDuringQuery = child.exitCode !== null || child.signalCode !== null;
  const ownedProcessExitedAtMs =
    options.ownedProcessExitedAtMs ?? options.resolveOwnedProcessExitedAtMs?.();
  const rootIdentity = processList.find((identity) => identity.pid === child.pid);
  // 查询期间原 root 退出后，PID 可能在 Node exit 回调与 CIM 返回之间
  // 被复用。查询完成时间不是受管进程的退出时间；一旦已观察到 child 退出，只能使用
  // 调用方记录的可信退出上界恢复旧后代，绝不能把同 PID 的当前进程认作原 root。
  const identities =
    rootIdentity && !childExitedDuringQuery
      ? [rootIdentity, ...collectProcessDescendants(child.pid, processList)]
      : collectExitedRootDescendants(
          child.pid,
          processList,
          options.ownedProcessStartedAtMs,
          ownedProcessExitedAtMs,
        );
  if (identities.length === 0) return undefined;
  return {
    rootPid: child.pid,
    descendantPids: identities
      .filter((identity) => identity.pid !== child.pid)
      .map((identity) => identity.pid),
    identities,
  };
}

function collectExitedRootDescendants(
  rootPid: number,
  processList: readonly ProcessIdentity[],
  startedAtMs: number | undefined,
  exitedAtMs: number | undefined,
): ProcessIdentity[] {
  if (
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    typeof exitedAtMs !== "number" ||
    !Number.isFinite(exitedAtMs)
  ) {
    return [];
  }
  const lifecycleCandidates = processList.filter((identity) => {
    const createdAtMs = parseWindowsCreationTimeMs(identity.startTime);
    return createdAtMs !== undefined && createdAtMs >= startedAtMs && createdAtMs < exitedAtMs;
  });
  return collectProcessDescendants(rootPid, lifecycleCandidates);
}

export async function captureExitedRootDescendantsSnapshotAsync(
  rootPid: number,
  options: ProcessTreeTerminatorOptions = {},
): Promise<ProcessTreeSnapshot | undefined> {
  if (process.platform !== "win32") {
    return captureExitedRootDescendantsSnapshot(rootPid, options);
  }
  const startedAtMs = options.ownedProcessStartedAtMs;
  const exitedAtMs = options.ownedProcessExitedAtMs;
  if (
    !Number.isInteger(rootPid) ||
    rootPid <= 0 ||
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    typeof exitedAtMs !== "number" ||
    !Number.isFinite(exitedAtMs)
  ) {
    return undefined;
  }
  const identities = collectExitedRootDescendants(
    rootPid,
    await readWindowsProcessListAsync(options),
    startedAtMs,
    exitedAtMs,
  );
  return identities.length === 0
    ? undefined
    : {
        rootPid,
        descendantPids: identities.map((identity) => identity.pid),
        identities,
      };
}
