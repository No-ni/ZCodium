import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withCredentialFileRead,
} from "@zcode/shared/node";
import { credentialRecordSchema } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";

const logger = createServiceLogger("credentialService");

function getCredentialsDir() {
  return getAppConfigDir();
}

function getCredentialsFile() {
  return join(getCredentialsDir(), "credentials.json");
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function readAll(
  credentialsFile = getCredentialsFile(),
  locked = false,
): Promise<Record<string, string>> {
  if (locked) return readAllUnchecked(credentialsFile);
  return withCredentialFileRead(credentialsFile, () => readAllUnchecked(credentialsFile));
}

function parseRecord(raw: Buffer): Record<string, string> {
  return credentialRecordSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
  );
}

function isCorruptRecord(raw: Buffer): boolean {
  try {
    parseRecord(raw);
    return false;
  } catch {
    return true;
  }
}

function fingerprint(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function readAllUnchecked(credentialsFile: string): Promise<Record<string, string>> {
  let raw: Buffer;
  try {
    raw = await readFile(credentialsFile);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read ZCode credentials: ${credentialsFile}`, { cause: error });
  }

  try {
    return parseRecord(raw);
  } catch (error) {
    // 把损坏 JSON/schema 当成空 store 后继续 save 会清空其他 OAuth 与登录凭据。
    // 保留损坏文件证据并向上传递错误，禁止自动覆盖。
    await backupCorruptFile(credentialsFile).catch(() => undefined);
    // 服务层日志必须统一经过分级 logger，确保生产环境的损坏凭据告警
    // 进入相同的落盘/采集策略，同时不记录凭据内容。
    logger.warn(undefined, "read failed; refusing to overwrite corrupt credential store");
    throw new Error(`ZCode credentials are corrupt: ${credentialsFile}`, { cause: error });
  }
}

async function writeAll(credentialsFile: string, data: Record<string, string>): Promise<void> {
  // 凭据路径之前在模块加载时就绑定到 homedir()，
  // Windows 测试里即使切换 HOME 也会继续写真实用户目录，导致隔离失效。
  await atomicWritePrivateTextFile(credentialsFile, `${JSON.stringify(data, null, 2)}\n`);
}
export {
  logger,
  getCredentialsDir,
  getCredentialsFile,
  getErrorCode,
  readAll,
  parseRecord,
  isCorruptRecord,
  fingerprint,
  readAllUnchecked,
  writeAll,
};
