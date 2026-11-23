import { randomBytes } from "node:crypto";
import "node:os";
import { link, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SystemCredentialCipherOptions } from "./contract.js";
import { KEY_BYTES, unavailable } from "./credentialCipherPrimitives.js";

async function resolveManagedSecret(
  options: Pick<SystemCredentialCipherOptions, "filePath" | "env">,
  discoverDefault = false,
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (env.ZCODE_CREDENTIAL_SECRET && env.ZCODE_CREDENTIAL_SECRET_FILE) throw unavailable();
  if (env.ZCODE_CREDENTIAL_SECRET) return env.ZCODE_CREDENTIAL_SECRET;
  const explicit = env.ZCODE_CREDENTIAL_SECRET_FILE;
  if (!explicit && !discoverDefault) return undefined;
  const path = explicit || join(dirname(resolve(options.filePath)), "credential-secret");
  const metadata = await stat(path).catch((error) => {
    if (!explicit && (error as { code?: string }).code === "ENOENT") return null;
    throw unavailable();
  });
  if (!metadata) return undefined;
  if (
    !metadata.isFile() ||
    (!explicit && process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  )
    throw unavailable();
  const value = await readFile(path, "utf8").catch(() => {
    throw unavailable();
  });
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 32 || bytes > 4096) throw unavailable();
  return value;
}

/** 调用方须持有 keyring 锁并确认目录未绑定来源；已有文件绝不覆盖。 */
async function publishPrivateSecretFile(secretPath: string): Promise<void> {
  const temporary = `${secretPath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, randomBytes(KEY_BYTES).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
    // 先完整写入，再排他发布；rename 会覆盖另一创建者，直接写目标会暴露半个密钥。
    await link(temporary, secretPath).catch((error) => {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    });
  } finally {
    await rm(temporary, { force: true });
  }
}
export { resolveManagedSecret, publishPrivateSecretFile };
