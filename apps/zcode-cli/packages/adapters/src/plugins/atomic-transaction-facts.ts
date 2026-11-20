import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

interface AtomicTransactionRecordV1 {
  stageName: string;
  version: 1;
}

interface AtomicTransactionRecordV2 {
  authorityPath?: string;
  hadTarget: boolean;
  mode: "coordinated" | "standalone";
  ownerId: string;
  ownerPid: number;
  stageName: string;
  transactionId: string;
  version: 2;
}

type AtomicTransactionRecord = AtomicTransactionRecordV1 | AtomicTransactionRecordV2;

const atomicProcessOwnerId = randomUUID();

function getAtomicRecoveryPaths(targetPath: string): {
  backupPath: string;
  transactionPath: string;
} {
  const parent = dirname(targetPath);
  const name = basename(targetPath);
  return {
    backupPath: join(parent, `.${name}.backup`),
    transactionPath: join(parent, `.${name}.transaction.json`),
  };
}

function isAtomicTransactionOwnerAlive(transaction: AtomicTransactionRecordV2): boolean {
  if (transaction.ownerPid === process.pid) {
    return transaction.ownerId === atomicProcessOwnerId;
  }
  try {
    process.kill(transaction.ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function authorityContainsTransactionSync(authorityPath: string, transactionId: string): boolean {
  let value: unknown;
  try {
    // 磁盘 marker 只可核验提交状态，不能把任意 authorityPath 递归派发为恢复/删除目标。
    value = JSON.parse(readFileSync(authorityPath, "utf8")) as unknown;
  } catch {
    return false;
  }
  return containsTransaction(value, transactionId);
}

function containsTransaction(value: unknown, transactionId: string): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (!Array.isArray(current) && "cacheTransactionId" in current) {
      const record = current as { cacheTransactionId?: unknown };
      if (record.cacheTransactionId === transactionId) return true;
    }
    pending.push(...(Array.isArray(current) ? current : Object.values(current)));
  }
  return false;
}

function parseAtomicTransaction(value: unknown): AtomicTransactionRecord | undefined {
  const parsed = value as Partial<AtomicTransactionRecord>;
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (parsed.version === 1 && typeof parsed.stageName === "string") {
    return { stageName: parsed.stageName, version: 1 };
  } else if (
    parsed.version === 2 &&
    typeof parsed.stageName === "string" &&
    typeof parsed.transactionId === "string" &&
    typeof parsed.ownerId === "string" &&
    Number.isSafeInteger(parsed.ownerPid) &&
    (parsed.ownerPid ?? 0) > 0 &&
    typeof parsed.hadTarget === "boolean" &&
    (parsed.mode === "coordinated" || parsed.mode === "standalone") &&
    (parsed.authorityPath === undefined || typeof parsed.authorityPath === "string")
  ) {
    return parsed as AtomicTransactionRecordV2;
  }
  return undefined;
}
export {
  type AtomicTransactionRecordV1,
  type AtomicTransactionRecordV2,
  type AtomicTransactionRecord,
  atomicProcessOwnerId,
  getAtomicRecoveryPaths,
  isAtomicTransactionOwnerAlive,
  authorityContainsTransactionSync,
  containsTransaction,
  parseAtomicTransaction,
};
