import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { BigIntStats } from "node:fs";
import type {
  WorkspaceCommittedSnapshot,
  WorkspaceCommittedSnapshotPort,
  WorkspaceCommittedSnapshotRequest,
} from "../contract.js";
import { WorkspaceAliasError } from "../contract.js";
import {
  assertSafePath,
  hash,
  openSafe,
  operationError,
  rootIdentity,
  type SafeFile,
} from "./files.js";

type CapturePhase = "handles-opened" | "bytes-captured" | "before-revalidate";
export interface NodeCommittedSnapshotOptions {
  afterCapturePhase?(phase: CapturePhase): void | Promise<void>;
}
interface HeldFile {
  readonly path: string;
  readonly file?: SafeFile;
}
interface FileObservation {
  readonly exists: boolean;
  readonly identity?: string;
  readonly byteLength?: string;
  readonly changeGeneration?: string;
  readonly byteHash?: string;
}
interface ObservedFile {
  readonly observation: FileObservation;
  readonly changed: boolean;
}

function changeGeneration(stat: BigIntStats): string {
  return hash({
    size: String(stat.size),
    mtime: String(stat.mtimeNs),
    ctime: String(stat.ctimeNs),
  });
}
function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkspaceAliasError("cancelled");
}

async function observeFile(held: HeldFile, signal?: AbortSignal): Promise<ObservedFile> {
  checkCancelled(signal);
  if (!held.file) return { observation: { exists: false }, changed: false };
  const before = await held.file.handle.stat({ bigint: true });
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WorkspaceAliasError("snapshot-unproven");
  }
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  let readable = true;
  try {
    while (position < Number(before.size)) {
      checkCancelled(signal);
      const { bytesRead } = await held.file.handle.read(
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - position),
        position,
      );
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
    // Windows SQLite可锁住SHM读取；缺字节只能阻断，不能借测试映射工具伪造生产证明。
    readable = false;
  }
  checkCancelled(signal);
  const after = await held.file.handle.stat({ bigint: true });
  const beforeGeneration = changeGeneration(before);
  const afterGeneration = changeGeneration(after);
  return {
    observation: {
      exists: true,
      identity: held.file.identity,
      byteLength: String(after.size),
      changeGeneration: afterGeneration,
      ...(readable && position === Number(before.size) ? { byteHash: digest.digest("hex") } : {}),
    },
    changed: beforeGeneration !== afterGeneration || (readable && position !== Number(before.size)),
  };
}

async function observeFiles(
  files: readonly HeldFile[],
  signal?: AbortSignal,
): Promise<ObservedFile[]> {
  const observations: ObservedFile[] = [];
  for (const file of files) observations.push(await observeFile(file, signal));
  return observations;
}

async function assertOriginalFiles(
  root: string,
  generation: string,
  files: readonly HeldFile[],
  signal?: AbortSignal,
): Promise<void> {
  checkCancelled(signal);
  if ((await rootIdentity(root)) !== generation) {
    throw new WorkspaceAliasError("snapshot-stale");
  }
  for (const held of files) {
    checkCancelled(signal);
    const exists = await assertSafePath(root, held.path, true);
    if (exists !== Boolean(held.file)) throw new WorkspaceAliasError("snapshot-stale");
    if (!held.file) continue;
    try {
      await held.file.assertCurrent();
    } catch (error) {
      if (error instanceof WorkspaceAliasError && error.code === "boundary-rejected") {
        throw new WorkspaceAliasError("snapshot-stale");
      }
      throw error;
    }
  }
}

export function createNodeCommittedSnapshotPort(
  options: NodeCommittedSnapshotOptions = {},
): WorkspaceCommittedSnapshotPort {
  return {
    async withSnapshot<T>(
      request: WorkspaceCommittedSnapshotRequest,
      _consumer: (snapshot: WorkspaceCommittedSnapshot) => Promise<T>,
    ): Promise<T> {
      const files: HeldFile[] = [];
      let failure: WorkspaceAliasError | undefined;
      try {
        checkCancelled(request.signal);
        const generation = await rootIdentity(request.dataRoot);
        for (const suffix of ["", "-wal", "-shm"]) {
          await assertSafePath(request.dataRoot, `${request.databasePath}${suffix}`, suffix !== "");
        }
        for (const suffix of ["", "-wal", "-shm"]) {
          checkCancelled(request.signal);
          const path = `${request.databasePath}${suffix}`;
          const exists = await assertSafePath(request.dataRoot, path, suffix !== "");
          files.push({
            path,
            ...(exists ? { file: await openSafe(request.dataRoot, path) } : {}),
          });
        }
        await options.afterCapturePhase?.("handles-opened");
        checkCancelled(request.signal);
        const before = await observeFiles(files, request.signal);
        await options.afterCapturePhase?.("bytes-captured");
        checkCancelled(request.signal);
        await options.afterCapturePhase?.("before-revalidate");
        await assertOriginalFiles(request.dataRoot, generation, files, request.signal);
        const after = await observeFiles(files, request.signal);
        await assertOriginalFiles(request.dataRoot, generation, files, request.signal);
        const pathHash = hash(resolve(request.databasePath));
        if (
          before.some((entry) => entry.changed) ||
          after.some((entry) => entry.changed) ||
          hash({ pathHash, files: before.map((entry) => entry.observation) }) !==
            hash({ pathHash, files: after.map((entry) => entry.observation) })
        ) {
          throw new WorkspaceAliasError("snapshot-stale");
        }
        checkCancelled(request.signal);
        // SHM映射可变化后恢复而hash/stat不变；Node文件API没有区间证明，永不发布副本或调用consumer。
        throw new WorkspaceAliasError("snapshot-unproven");
      } catch (error) {
        failure = operationError(error);
      }
      const cleanupErrors: unknown[] = [];
      for (const held of files.toReversed()) {
        if (!held.file) continue;
        try {
          await held.file.handle.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length) {
        throw new WorkspaceAliasError(failure?.code ?? "io-failed", {
          cause: new AggregateError(
            [...(failure ? [failure] : []), ...cleanupErrors],
            "Committed snapshot capture cleanup failed",
          ),
        });
      }
      throw failure ?? new WorkspaceAliasError("snapshot-unproven");
    },
  };
}
