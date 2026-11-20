import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "../node/privateFilePersistence.js";
import type {
  CredentialCipher,
  SystemCredentialCipherOptions,
  SystemCredentialCipher,
} from "./contract.js";
import {
  LEGACY_PREFIX,
  SYSTEM_PREFIX,
  CREDENTIAL_SOURCE_FILE,
  OS_SOURCE_MARKER,
  unavailable,
  open,
  legacyKeyCandidates,
  createLegacyCipher,
} from "./credentialCipherPrimitives.js";
import { resolveManagedSecret, publishPrivateSecretFile } from "./credentialSecretFile.js";
import { createSystemCredentialCipher } from "./systemCredentialCipher.js";

/** Desktop 显式请求远端准备；随机密钥只在目标机生成，不能随连接结果返回。 */
export async function prepareServerCredentialStorage(
  options: Pick<SystemCredentialCipherOptions, "filePath" | "env">,
): Promise<void> {
  const env = options.env ?? process.env;
  if (env.ZCODE_CREDENTIAL_SECRET || env.ZCODE_CREDENTIAL_SECRET_FILE) return;
  const filePath = resolve(options.filePath);
  const secretPath = join(dirname(filePath), "credential-secret");
  // 与迁移保持同一锁序，避免迁移持有凭据锁并等待密钥锁时互相阻塞。
  await withFileLock(filePath, () =>
    withFileLock(`${filePath}.keyring`, async () => {
      const existing = await lstat(secretPath).catch((error) => {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      });
      if (existing) return;
      const pinnedSource = await readFile(
        join(dirname(filePath), CREDENTIAL_SOURCE_FILE),
        "utf8",
      ).catch((error) => {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      });
      if (pinnedSource !== null) {
        if (pinnedSource !== OS_SOURCE_MARKER) throw unavailable();
        return;
      }
      const raw = await readFile(filePath, "utf8").catch((error) => {
        if ((error as { code?: string }).code === "ENOENT") return "";
        throw error;
      });
      // 已有 v2 数据意味着已有独立密钥来源。丢失密钥时不能生成替代品或切换来源。
      if (raw.includes(SYSTEM_PREFIX)) return;
      await publishPrivateSecretFile(secretPath);
    }),
  );
}

/** Server 无交互 shell；读取持久私有文件，准备动作由启动命令显式负责。 */
export async function createLegacyServerCredentialCipher(
  options: Pick<SystemCredentialCipherOptions, "filePath" | "env">,
): Promise<CredentialCipher> {
  return await withFileLock(options.filePath, async () => {
    const raw = await readFile(options.filePath, "utf8").catch((error) => {
      if ((error as { code?: string }).code === "ENOENT") return "";
      throw error;
    });
    // 旧 Supervisor 可能自动拉回旧 Core；在 handoff 前不能写入它不认识的新密文。
    if (raw.includes(SYSTEM_PREFIX)) throw unavailable();
    const env = options.env ?? process.env;
    const secret = await resolveManagedSecret(options, true);
    const keys = legacyKeyCandidates({ ...env, ZCODE_CREDENTIAL_SECRET: secret });
    let values: string[] = [];
    try {
      values = Object.values(JSON.parse(raw || "{}")).filter(
        (value): value is string => typeof value === "string" && value.startsWith(LEGACY_PREFIX),
      );
    } catch {
      /* 损坏容器仍由既有 Store 恢复路径处理。 */
    }
    // 随机文件可能刚为升级准备。继续使用已认证的历史密钥，不能提前让旧 Core 失去读权限。
    const writeKey =
      keys.find((key) =>
        values.some((value) => {
          try {
            open(value.slice(LEGACY_PREFIX.length), key);
            return true;
          } catch {
            return false;
          }
        }),
      ) ??
      (env.ZCODE_CREDENTIAL_SECRET || env.ZCODE_CREDENTIAL_SECRET_FILE
        ? keys[0]!
        : legacyKeyCandidates(env)[0]!);
    const cipher = createLegacyCipher(keys, writeKey);
    return {
      ...cipher,
      decrypt(value: string) {
        if (value.startsWith(SYSTEM_PREFIX)) throw unavailable();
        return cipher.decrypt(value);
      },
    };
  });
}

export async function createServerCredentialCipher(
  options: SystemCredentialCipherOptions,
): Promise<SystemCredentialCipher> {
  const env = options.env ?? process.env;
  const defaultFile = join(dirname(resolve(options.filePath)), "credential-secret");
  try {
    const cipher = createSystemCredentialCipher({ ...options, env });
    await cipher.initialize();
    return cipher;
  } catch (error) {
    // 首句保留操作方法，确保 Supervisor 有界错误摘要和 Desktop 连接详情仍能展示。
    throw Object.assign(
      new Error(
        `Remote credential storage unavailable. Restore or create the correct private (0600), 32–4096 byte credential-secret file in the remote ZCode config directory (${dirname(defaultFile)}), then reconnect. Or configure ZCODE_CREDENTIAL_SECRET_FILE before starting the remote service. Existing encrypted data requires its original key.`,
        { cause: error },
      ),
      { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" },
    );
  }
}
