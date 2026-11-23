import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import "node:path";
import { CREDENTIAL_DECRYPT_ERROR_CODE, CREDENTIAL_DECRYPT_ERROR_PREFIX } from "@zcode/shared";
import type { CredentialCipher } from "./contract.js";

const LEGACY_PREFIX = "enc:v1:";

const SYSTEM_PREFIX = "enc:v2:";

const ALGORITHM = "aes-256-gcm";

const KEY_BYTES = 32;

const IV_BYTES = 12;

const TAG_BYTES = 16;

/** 与凭据文件同目录的来源标记；内容只能是 OS_SOURCE_MARKER，不含密钥。 */
const CREDENTIAL_SOURCE_FILE = "credential-source";

const OS_SOURCE_MARKER = "os\n";

function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function decryptError(): Error {
  return Object.assign(
    new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}Invalid encrypted credential`),
    { code: CREDENTIAL_DECRYPT_ERROR_CODE },
  );
}

function unavailable(): Error {
  // 系统库锁定/缺失不能冒充密文损坏，否则既有 OAuth 恢复逻辑会误删登录。
  return Object.assign(
    new Error(
      "System credential storage is unavailable. Unlock the OS credential store and restart to retry; headless servers require Secret Service, ZCODE_CREDENTIAL_SECRET, or a readable ZCODE_CREDENTIAL_SECRET_FILE of 32–4096 bytes. Do not configure both managed secret sources.",
    ),
    { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" },
  );
}

function seal(value: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map((part) => part.toString("base64url")).join(".");
}

function open(payload: string, key: Buffer): string {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part)))
    throw decryptError();
  const [iv, tag, bytes] = parts.map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !bytes || iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw decryptError();
  try {
    const cipher = createDecipheriv(ALGORITHM, key, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(bytes), cipher.final()]).toString("utf8");
  } catch {
    throw decryptError();
  }
}

function legacyKeyCandidates(env: Readonly<Record<string, string | undefined>>): Buffer[] {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    /* 兼容旧版本的同一默认推导规则。 */
  }
  const fallback = `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
  const secret = env.ZCODE_CREDENTIAL_SECRET;
  // 旧 Desktop 使用原字符串，旧 CLI 会 trim；不能让共用 decoder 破坏任一端升级。
  // GCM 认证决定正确历史密钥，绝不把解密失败的密文作为明文返回。
  // 首次配置随机密钥时，旧记录仍可能使用默认派生密钥，必须先读旧值再迁移。
  const keys = [...new Set([secret || fallback, secret?.trim() || fallback, fallback])].map(digest);
  return keys;
}

/** 仅兼容旧容器及显式 fixture；默认运行时必须使用 createSystemCredentialCipher。 */
export function createLegacyCredentialCipher(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { encrypt(value: string): string; decrypt(value: string): string } {
  return createLegacyCipher(legacyKeyCandidates(env));
}

function createLegacyCipher(keys: Buffer[], writeKey = keys[0]!) {
  return {
    encrypt: (value: string) => LEGACY_PREFIX + seal(value, writeKey),
    decrypt(value: string) {
      if (value.startsWith(LEGACY_PREFIX)) {
        for (const key of keys) {
          try {
            return open(value.slice(LEGACY_PREFIX.length), key);
          } catch {
            /* 继续尝试另一端的历史规则。 */
          }
        }
        throw decryptError();
      }
      if (value.startsWith("enc:")) throw decryptError();
      return value;
    },
  };
}

/** 调用方须在既有文件锁内读、迁移和写；不会修改传入对象，失败时不产生半份迁移。 */
export async function migrateCredentialRecord(
  record: Readonly<Record<string, string>>,
  cipher: CredentialCipher,
): Promise<Record<string, string> | null> {
  const needsMigration = cipher.needsMigration;
  if (!needsMigration) return null;
  if (!Object.values(record).some((value) => needsMigration(value))) return null;
  // 混合新旧容器先验证已有新格式的密钥来源；不能迁移一半后才发现原密钥不可用。
  for (const value of Object.values(record)) {
    if (needsMigration(value)) continue;
    try {
      await cipher.decrypt(value);
    } catch (error) {
      if ((error as { code?: unknown })?.code !== CREDENTIAL_DECRYPT_ERROR_CODE) throw error;
    }
  }
  const next = { ...record };
  let changed = false;
  for (const [key, value] of Object.entries(record)) {
    if (!needsMigration(value)) continue;
    let plain: string;
    try {
      plain = await cipher.decrypt(value);
    } catch (error) {
      if ((error as { code?: unknown })?.code === CREDENTIAL_DECRYPT_ERROR_CODE) continue;
      throw error;
    }
    next[key] = await cipher.encrypt(plain);
    changed = true;
  }
  return changed ? next : null;
}
export {
  LEGACY_PREFIX,
  SYSTEM_PREFIX,
  ALGORITHM,
  KEY_BYTES,
  IV_BYTES,
  TAG_BYTES,
  CREDENTIAL_SOURCE_FILE,
  OS_SOURCE_MARKER,
  digest,
  decryptError,
  unavailable,
  seal,
  open,
  legacyKeyCandidates,
  createLegacyCipher,
};
