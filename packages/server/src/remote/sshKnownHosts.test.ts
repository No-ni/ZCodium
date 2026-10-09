import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SSHConnectOptions } from "@zcode/shared";
import {
  computeHostKeyFingerprint,
  createSSHHostVerifier,
  formatHostKeyRejectionError,
  getSSHKnownHostsPath,
  SSHHostKeyStore,
  type SSHHostKeyRejection,
} from "./sshKnownHosts.js";
import { buildSSHConnectConfig, normalizeSSHConnectError } from "./sshAuth.js";

const target: SSHConnectOptions = {
  kind: "ssh",
  host: "deploy.example.com",
  port: 22,
  username: "root",
  privateKeyPath: "~/.ssh/id_ed25519",
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ssh-known-hosts-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function storePath(): string {
  return join(directory, "known-hosts.json");
}

function fingerprintOf(seed: string): string {
  return computeHostKeyFingerprint(Buffer.from(seed));
}

describe("SSHHostKeyStore", () => {
  it("首连接受并落库，记录含算法与指纹", async () => {
    const store = new SSHHostKeyStore({ filePath: storePath() });
    const verdict = await store.verify(target, fingerprintOf("server-key-1"));

    expect(verdict.outcome).toBe("first-use");
    const persisted = JSON.parse(await readFile(storePath(), "utf8"));
    expect(persisted.schemaVersion).toBe(1);
    const records = Object.values(persisted.hosts) as Array<Record<string, string>>;
    expect(records).toHaveLength(1);
    expect(records[0]?.fingerprint).toBe(fingerprintOf("server-key-1"));
    expect(records[0]?.algorithm).toBe("sha256");
  });

  it("记录匹配时再次连接接受", async () => {
    const store = new SSHHostKeyStore({ filePath: storePath() });
    await store.verify(target, fingerprintOf("server-key-1"));

    const verdict = await store.verify(target, fingerprintOf("server-key-1"));
    expect(verdict.outcome).toBe("match");
  });

  it("指纹不一致时拒绝，且不覆盖已有记录", async () => {
    const store = new SSHHostKeyStore({ filePath: storePath() });
    await store.verify(target, fingerprintOf("server-key-1"));

    const verdict = await store.verify(target, fingerprintOf("attacker-key"));
    expect(verdict.outcome).toBe("reject");
    if (verdict.outcome !== "reject" || verdict.reason !== "changed") {
      throw new Error("unreachable");
    }
    expect(verdict.expected).toBe(fingerprintOf("server-key-1"));
    expect(verdict.received).toBe(fingerprintOf("attacker-key"));

    const persisted = JSON.parse(await readFile(storePath(), "utf8"));
    const records = Object.values(persisted.hosts) as Array<Record<string, string>>;
    expect(records[0]?.fingerprint).toBe(fingerprintOf("server-key-1"));
  });

  it("存储键不含凭据：仅密码不同的同一主机共享判定", async () => {
    const store = new SSHHostKeyStore({ filePath: storePath() });
    await store.verify({ ...target, password: "first-password" }, fingerprintOf("server-key-1"));

    const verdict = await store.verify(
      { ...target, password: "other-password" },
      fingerprintOf("server-key-1"),
    );
    expect(verdict.outcome).toBe("match");

    const raw = await readFile(storePath(), "utf8");
    expect(raw).not.toContain("first-password");
    expect(raw).not.toContain("other-password");
  });

  it("known_hosts 损坏时 fail-closed 拒绝，且不静默重建", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(storePath(), "{ not json", "utf8");
    const store = new SSHHostKeyStore({ filePath: storePath() });

    const verdict = await store.verify(target, fingerprintOf("server-key-1"));
    expect(verdict.outcome).toBe("reject");
    if (verdict.outcome !== "reject") throw new Error("unreachable");
    expect(verdict.reason).toBe("store-error");
  });

  it("schema 不兼容时 fail-closed 拒绝", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(storePath(), JSON.stringify({ schemaVersion: 999, hosts: {} }), "utf8");
    const store = new SSHHostKeyStore({ filePath: storePath() });

    const verdict = await store.verify(target, fingerprintOf("server-key-1"));
    expect(verdict.outcome).toBe("reject");
  });
});

describe("createSSHHostVerifier", () => {
  it("首连回调 verify(true)，不记录拒绝", async () => {
    const rejections: SSHHostKeyRejection[] = [];
    const verifier = createSSHHostVerifier({
      store: new SSHHostKeyStore({ filePath: storePath() }),
      target,
      onRejection: (rejection) => rejections.push(rejection),
    });

    const ok = await new Promise<boolean>((resolve) => {
      verifier(Buffer.from("server-key-1"), resolve);
    });
    expect(ok).toBe(true);
    expect(rejections).toHaveLength(0);
  });

  it("密钥变更先记录可区分的拒绝原因，再回调 verify(false)", async () => {
    const store = new SSHHostKeyStore({ filePath: storePath() });
    await store.verify(target, fingerprintOf("server-key-1"));

    const rejections: SSHHostKeyRejection[] = [];
    const verifier = createSSHHostVerifier({
      store,
      target,
      onRejection: (rejection) => rejections.push(rejection),
    });

    const ok = await new Promise<boolean>((resolve) => {
      verifier(Buffer.from("attacker-key"), resolve);
    });
    expect(ok).toBe(false);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("changed");
  });
});

describe("formatHostKeyRejectionError", () => {
  it("密钥变更的错误带安全语义与清理路径", () => {
    const error = formatHostKeyRejectionError(
      { hostKey: "k", reason: "changed", detail: "ignored" },
      "/data/known-hosts.json",
    );
    expect(error.message).toContain("中间人");
    expect(error.message).toContain("/data/known-hosts.json");
  });

  it("存储故障的错误带环境原因，不谎称密钥变更", () => {
    const error = formatHostKeyRejectionError(
      { hostKey: "k", reason: "store-error", detail: "EACCES" },
      "/data/known-hosts.json",
    );
    expect(error.message).toContain("EACCES");
    expect(error.message).not.toContain("中间人");
  });
});

describe("sshAuth 接线", () => {
  it("buildSSHConnectConfig 透传 hostVerifier", () => {
    const hostVerifier = () => {};
    const config = buildSSHConnectConfig({
      host: "deploy.example.com",
      username: "root",
      hostVerifier,
    });
    expect(config.hostVerifier).toBe(hostVerifier);
  });

  it("normalizeSSHConnectError 把 ssh2 的 host denied 映射为产品文案", () => {
    const error = normalizeSSHConnectError(new Error("Host denied (verification failed)"));
    expect(error.message).toContain("主机密钥校验未通过");
  });

  it("其余 SSH 错误文案不受影响", () => {
    const error = normalizeSSHConnectError({ level: "client-authentication" });
    expect(error.message).toContain("认证失败");
  });
});

describe("getSSHKnownHostsPath", () => {
  it("落在应用配置根的 ssh 子目录", () => {
    expect(getSSHKnownHostsPath()).toContain("ssh");
    expect(getSSHKnownHostsPath().endsWith("known-hosts.json")).toBe(true);
  });
});
