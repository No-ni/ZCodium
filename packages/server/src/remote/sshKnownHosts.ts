import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { buildSshRemoteHostKey, type SSHConnectOptions } from "@zcode/shared";
import { getAppConfigDir } from "@zcode/services/node";

/**
 * SSH 主机密钥 TOFU（trust on first use）存储与判定。
 *
 * 背景见 .agents/specs/ssh-remote-hardening.md 缺陷 1：ssh2 未配置 hostVerifier 时接受任意
 * 主机密钥，中间人可冒充目标主机完成密钥交换，骗取用户密码 / 私钥口令。这里按 OpenSSH 默认
 * 策略补齐校验：
 * - 无记录 → 接受并落库（首次连接）；
 * - 记录匹配 → 接受；
 * - 记录不匹配 → 拒绝，且拒绝原因可区分（主机密钥变更 vs 存储故障），不得静默重连。
 *
 * 存储键复用 buildSshRemoteHostKey()：它已刻意排除密码与私钥口令，只含
 * host/port/username/认证方式/私钥路径，这一约束必须保持——known_hosts 落盘文件不得
 * 携带任何凭据。
 */

const KNOWN_HOSTS_SCHEMA_VERSION = 1;
const HOST_KEY_DIGEST_ALGORITHM = "sha256";

export interface KnownHostRecord {
  algorithm: typeof HOST_KEY_DIGEST_ALGORITHM;
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface KnownHostsFile {
  schemaVersion: number;
  hosts: Record<string, KnownHostRecord>;
}

export type HostKeyVerdict =
  | { outcome: "first-use"; record: KnownHostRecord }
  | { outcome: "match"; record: KnownHostRecord }
  | { outcome: "reject"; reason: "changed"; expected: string; received: string }
  | { outcome: "reject"; reason: "store-error"; detail: string };

export function getSSHKnownHostsPath(): string {
  return join(getAppConfigDir(), "ssh", "known-hosts.json");
}

/** 主机公钥指纹：sha256(原始主机公钥) 的 hex。稳定、可复算，不引入外部格式依赖。 */
export function computeHostKeyFingerprint(key: Buffer): string {
  return createHash(HOST_KEY_DIGEST_ALGORITHM).update(key).digest("hex");
}

function readKnownHostsFile(value: unknown): KnownHostsFile | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Partial<KnownHostsFile>;
  if (candidate.schemaVersion !== KNOWN_HOSTS_SCHEMA_VERSION) {
    return null;
  }
  if (
    typeof candidate.hosts !== "object" ||
    candidate.hosts === null ||
    Array.isArray(candidate.hosts)
  ) {
    return null;
  }

  const hosts: Record<string, KnownHostRecord> = {};
  for (const [hostKey, record] of Object.entries(candidate.hosts)) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      return null;
    }
    const candidateRecord = record as Partial<KnownHostRecord>;
    if (
      candidateRecord.algorithm !== HOST_KEY_DIGEST_ALGORITHM ||
      typeof candidateRecord.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidateRecord.fingerprint) ||
      typeof candidateRecord.firstSeenAt !== "string" ||
      typeof candidateRecord.lastSeenAt !== "string"
    ) {
      return null;
    }
    hosts[hostKey] = {
      algorithm: candidateRecord.algorithm,
      fingerprint: candidateRecord.fingerprint,
      firstSeenAt: candidateRecord.firstSeenAt,
      lastSeenAt: candidateRecord.lastSeenAt,
    };
  }

  return { schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, hosts };
}

async function writeKnownHostsFile(
  filePath: string,
  hosts: Record<string, KnownHostRecord>,
): Promise<void> {
  const payload: KnownHostsFile = { schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, hosts };
  await atomicWritePrivateTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

export interface SSHHostKeyStoreOptions {
  filePath?: string;
  now?: () => Date;
}

/**
 * 主机密钥存储。filePath 可注入以便测试落到临时目录；默认跟随应用配置根
 * （<数据根>/.zcodium/v2/ssh/known-hosts.json），新目录首次使用自动创建，
 * 不涉及既有数据迁移。
 */
export class SSHHostKeyStore {
  private readonly filePath: string;
  private readonly now: () => Date;

  constructor(options: SSHHostKeyStoreOptions = {}) {
    this.filePath = options.filePath ?? getSSHKnownHostsPath();
    this.now = options.now ?? (() => new Date());
  }

  private async load(): Promise<KnownHostsFile | null> {
    try {
      return readKnownHostsFile(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, hosts: {} };
      }
      throw error;
    }
  }

  private async persist(hosts: Record<string, KnownHostRecord>): Promise<void> {
    await writeKnownHostsFile(this.filePath, hosts);
  }

  /** 首连必须落库；读取和锁故障拒绝，已匹配指纹后的 lastSeenAt 刷新失败可沿用旧记录。 */
  async verify(target: SSHConnectOptions, fingerprint: string): Promise<HostKeyVerdict> {
    try {
      // 缓存和固定 .part 会让并发首连丢记录，甚至同时信任不同密钥；锁内只读磁盘最新事实。
      return await withFileLock(this.filePath, () => this.verifyLocked(target, fingerprint));
    } catch (error) {
      return {
        outcome: "reject",
        reason: "store-error",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async verifyLocked(
    target: SSHConnectOptions,
    fingerprint: string,
  ): Promise<HostKeyVerdict> {
    const hostKey = buildSshRemoteHostKey(target);

    let hosts: Record<string, KnownHostRecord>;
    try {
      const file = await this.load();
      if (!file) {
        return {
          outcome: "reject",
          reason: "store-error",
          detail: `known_hosts 无法解析：${this.filePath}`,
        };
      }
      hosts = file.hosts;
    } catch (error) {
      return {
        outcome: "reject",
        reason: "store-error",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const existing = hosts[hostKey];
    const nowIso = this.now().toISOString();

    if (!existing) {
      const record: KnownHostRecord = {
        algorithm: HOST_KEY_DIGEST_ALGORITHM,
        fingerprint,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
      };
      try {
        await this.persist({ ...hosts, [hostKey]: record });
      } catch (error) {
        // 首连判定通过但记录写不进去（只读配置目录、磁盘故障等）时选择拒绝而不是放行：
        // TOFU 的全部价值在于“下次能发现变更”，写不进去就等于静默失去这层保护。
        // 拒绝信息带路径与原因，用户能直接定位（通常是配置目录权限），好过无声降级。
        return {
          outcome: "reject",
          reason: "store-error",
          detail: `首连记录写入失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return { outcome: "first-use", record };
    }

    if (existing.fingerprint !== fingerprint) {
      // 密钥变更：绝不覆盖记录、绝不静默重连，原因可区分地上抛。
      return {
        outcome: "reject",
        reason: "changed",
        expected: existing.fingerprint,
        received: fingerprint,
      };
    }

    const refreshed: KnownHostRecord = { ...existing, lastSeenAt: nowIso };
    try {
      await this.persist({ ...hosts, [hostKey]: refreshed });
    } catch {
      // lastSeenAt 刷新失败不影响安全判定：记录已在位且匹配，连接继续。
      return { outcome: "match", record: existing };
    }
    return { outcome: "match", record: refreshed };
  }
}

export interface SSHHostKeyRejection {
  hostKey: string;
  reason: "changed" | "store-error";
  detail: string;
}

/**
 * 把拒绝原因翻译成用户可操作的错误文案。变更与存储故障必须可区分：
 * 前者是安全事件（可能是中间人），后者是环境问题（通常是配置目录权限）。
 */
export function formatHostKeyRejectionError(
  rejection: SSHHostKeyRejection,
  filePath: string,
): Error {
  if (rejection.reason === "changed") {
    return new Error(
      `SSH 主机密钥校验失败：本次连接的主机密钥与首次连接时记录的不一致，已拒绝连接以防中间人攻击。` +
        `若该服务器确实更换了主机密钥，请删除 ${filePath} 中此主机的记录后重试。`,
    );
  }

  return new Error(`SSH 主机密钥记录不可用，已拒绝连接：${rejection.detail}`);
}

/**
 * 生成 ssh2 的 hostVerifier。判定为拒绝时先通过 onRejection 记录可区分的原因，
 * 再回调 verify(false)——ssh2 对 verify(false) 只抛固定的
 * "Host denied (verification failed)"，不记录就分不清是密钥变更还是存储故障。
 */
export function createSSHHostVerifier(params: {
  store: SSHHostKeyStore;
  target: SSHConnectOptions;
  onRejection: (rejection: SSHHostKeyRejection) => void;
  isActive?: () => boolean;
}): (key: Buffer, verify: (valid: boolean) => void) => void {
  const { store, target, onRejection, isActive } = params;
  const hostKey = buildSshRemoteHostKey(target);

  return (key, verify) => {
    void (async () => {
      const verdict = await store.verify(target, computeHostKeyFingerprint(key));
      // 文件锁等待期间连接可能已退役；迟到 verify(false) 会再次销毁 ssh2 协议并抛未处理拒绝。
      // 在记录原因和回调前检查连接代际，避免旧结果污染重试，也不打断已开始的存储事务。
      if (isActive && !isActive()) return;
      if (verdict.outcome === "reject") {
        const detail =
          verdict.reason === "changed"
            ? `记录指纹 ${verdict.expected.slice(0, 16)}…，本次 ${verdict.received.slice(0, 16)}…`
            : verdict.detail;
        onRejection({ hostKey, reason: verdict.reason, detail });
        verify(false);
        return;
      }
      verify(true);
    })();
  };
}
