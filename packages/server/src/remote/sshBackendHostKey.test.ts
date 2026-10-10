import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { SSHBackend } from "./ssh-backend.js";
import { SSHHostKeyStore, type HostKeyVerdict } from "./sshKnownHosts.js";

vi.mock("ssh2", () => ({
  Client: class extends EventEmitter {
    connect(config: { hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => void }) {
      config.hostVerifier(Buffer.from("fixture-key"), (valid) => {
        this.emit(
          "error",
          valid
            ? Object.assign(new Error("All configured authentication methods failed"), {
                level: "client-authentication",
              })
            : new Error("Host denied (verification failed)"),
        );
      });
    }
    end() {}
  },
}));

afterEach(() => vi.restoreAllMocks());

const rejections: HostKeyVerdict[] = [
  { outcome: "reject", reason: "changed", expected: "a".repeat(64), received: "b".repeat(64) },
  { outcome: "reject", reason: "store-error", detail: "fixture store unavailable" },
];

it.each(rejections)("连接入口返回具体主机密钥拒绝原因 $reason", async (verdict) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(SSHHostKeyStore.prototype, "verify").mockResolvedValue(verdict);
  const backend = new SSHBackend({
    host: "fixture.invalid",
    username: "fixture",
    password: "fixture",
  });
  try {
    await expect(backend.detect()).rejects.toThrow(
      verdict.outcome === "reject" && verdict.reason === "changed"
        ? "本次连接的主机密钥与首次连接时记录的不一致"
        : "fixture store unavailable",
    );
  } finally {
    backend.dispose();
  }
});

it("重新连接时旧主机密钥拒绝不掩盖新认证错误", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(SSHHostKeyStore.prototype, "verify")
    .mockResolvedValueOnce(rejections[0]!)
    .mockResolvedValueOnce({
      outcome: "match",
      record: {
        algorithm: "sha256",
        fingerprint: "a".repeat(64),
        firstSeenAt: "fixture",
        lastSeenAt: "fixture",
      },
    });
  const backend = new SSHBackend({
    host: "fixture.invalid",
    username: "fixture",
    password: "fixture",
  });
  try {
    await expect(backend.detect()).rejects.toThrow();
    await expect(backend.detect()).rejects.toThrow("SSH 认证失败");
  } finally {
    backend.dispose();
  }
});
