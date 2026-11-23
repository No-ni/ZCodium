import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticRecordSchema } from "@zcode/shared";
import { LogLevel, LogLevelName } from "@zcode/contracts";
import {
  LOG_CLEANUP_STARTUP_DELAY_MS,
  cleanupLogRetention,
  createNodeLoggerFactory,
  formatLocalLogDate,
} from "../src/logging/index.js";

describe("Node logging adapter", () => {
  it("生产等级异步写入安全指标，不保存原文或凭据", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-ttft-"));
    const factory = createNodeLoggerFactory({ logDir, minLevel: LogLevel.Info });
    try {
      const logger = factory.createLogger("model");
      logger.info("model first content", {
        event: "ttft.model.first_content",
        requestId: "request",
        durationMs: 5,
        apiKey: "secret",
      });
      await factory.flush();
      const [file] = await readdir(factory.getLogDir());
      const content = await readFile(join(factory.getLogDir(), file!), "utf8");
      expect(DiagnosticRecordSchema.parse(JSON.parse(content).diagnostic).metrics).toEqual({ durationMs: 5 });
      expect(content).not.toContain("model first content");
      expect(content).not.toContain("secret");
    } finally {
      await factory.flush();
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("formats log file dates from the local calendar day", () => {
    expect(formatLocalLogDate(new Date(2026, 4, 5, 2, 46, 0))).toBe("2026-05-05");
  });

  it("writes validated JSONL without arbitrary context keys", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-"));
    const factory = createNodeLoggerFactory({ logDir, minLevel: LogLevel.Debug });

    try {
      const logger = factory
        .createLogger("test")
        .child({
          event: "test.event",
          traceId: "trace_123" as never,
        });

      logger.info("hello", {
        apiKey: "secret",
        nested: {
          token: "token-value",
          safe: "visible",
        },
      });

      await factory.flush();
      const files = await readdir(factory.getLogDir());
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/);

      const content = await readFile(join(factory.getLogDir(), files[0]!), "utf8");
      const entry = JSON.parse(content.trim());
      expect(entry.level).toBe(LogLevelName[LogLevel.Info]);
      expect(DiagnosticRecordSchema.safeParse(entry.diagnostic).success).toBe(true);
      expect(entry.diagnostic.traceId).not.toBe("trace_123");
      for (const unsafe of ["secret", "token-value", "visible", "hello"])
        expect(content).not.toContain(unsafe);
    } finally {
      await factory.flush();
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("does not throw when the log sink cannot be written", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-log-fail-"));
    const fileAsDirectory = join(tempRoot, "not-a-directory");
    const factory = createNodeLoggerFactory({ logDir: fileAsDirectory });

    try {
      await writeFile(fileAsDirectory, "");
      const logger = factory.createLogger("test");

      expect(() => logger.info("still returns")).not.toThrow();
    } finally {
      await factory.flush();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("swallows a real filesystem failure at JSONL append", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-fault-"));
    const factory = createNodeLoggerFactory({ logDir });
    const file = `zcode-${formatLocalLogDate(new Date())}.jsonl`;
    await mkdir(join(factory.getLogDir(), file), { recursive: true });

    try {
      const logger = factory.createLogger("test");

      expect(() => logger.info("still returns")).not.toThrow();
      await expect(factory.flush()).resolves.toBeUndefined();
      await expect(readdir(join(factory.getLogDir(), file))).resolves.toEqual([]);
    } finally {
      await factory.flush();
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("swallows a real filesystem failure before log directory creation", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-log-fault-"));
    const logDir = join(tempRoot, "logs");
    await writeFile(logDir, "blocked directory");
    const factory = createNodeLoggerFactory({ logDir });

    try {
      const logger = factory.createLogger("test");

      expect(() => logger.warn("still returns")).not.toThrow();
      await expect(factory.flush()).resolves.toBeUndefined();
      await expect(readFile(logDir, "utf8")).resolves.toBe("blocked directory");
    } finally {
      await factory.flush();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("defaults to debug logging in development mode", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-dev-"));
    const factory = createNodeLoggerFactory({ env: { ZCODE_RUNTIME_ENV: "development" }, logDir });

    try {
      const logger = factory.createLogger("test");

      logger.debug("dev-only");

      await factory.flush();
      const files = await readdir(factory.getLogDir());
      expect(files).toHaveLength(1);
      const content = await readFile(join(factory.getLogDir(), files[0]!), "utf8");
      const entry = JSON.parse(content.trim());
      expect(entry.level).toBe(LogLevelName[LogLevel.Debug]);
      expect(DiagnosticRecordSchema.safeParse(entry.diagnostic).success).toBe(true);
      expect(content).not.toContain("dev-only");
    } finally {
      await factory.flush();
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("ignores ambient NODE_ENV when resolving development logging", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-node-env-ignored-"));
    const factory = createNodeLoggerFactory({ env: { NODE_ENV: "development" }, logDir });

    try {
      const logger = factory.createLogger("test");

      logger.debug("hidden");

      await factory.flush();
      const files = await readdir(logDir);
      expect(files).toHaveLength(0);
    } finally {
      await factory.flush();
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("ignores ZCODE_LOG_LEVEL so development mode keeps debug logging", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-dev-env-ignored-"));
    const factory = createNodeLoggerFactory({
      env: { ZCODE_RUNTIME_ENV: "development", ZCODE_LOG_LEVEL: "info" }, logDir,
    });

    try {
      const logger = factory.createLogger("test");

      logger.debug("still-visible");

      await factory.flush();
      const files = await readdir(factory.getLogDir());
      expect(files).toHaveLength(1);
      const content = await readFile(join(factory.getLogDir(), files[0]!), "utf8");
      const entry = JSON.parse(content.trim());
      expect(entry.level).toBe(LogLevelName[LogLevel.Debug]);
      expect(DiagnosticRecordSchema.safeParse(entry.diagnostic).success).toBe(true);
      expect(content).not.toContain("still-visible");
    } finally {
      await factory.flush();
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("writes a bounded failure diagnostic without raw error cause chains", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-cause-"));
    const factory = createNodeLoggerFactory({ logDir, minLevel: LogLevel.Debug });

    try {
      const logger = factory
        .createLogger("test")
        .child({
          event: "turn.failed",
          traceId: "trace_failed" as never,
        });
      const cause = new Error("Model provider is missing an API key: openai") as Error & {
        code?: string;
        context?: Record<string, unknown>;
      };
      cause.name = "AiSdkModelAdapterError";
      cause.code = "provider_not_configured";
      cause.context = {
        apiKey: "secret-value",
        envKey: "ZCODE_API_KEY",
        providerId: "openai",
      };

      const error = new Error("Turn execution failed") as Error & {
        cause?: unknown;
        code?: string;
        type?: string;
      };
      error.code = "UNKNOWN_ERROR";
      error.type = "unknown_error";
      error.cause = cause;

      logger.error("Turn failed", error, { module: "core.runtime", status: "failed" });

      await factory.flush();
      const files = await readdir(factory.getLogDir());
      const content = await readFile(join(factory.getLogDir(), files[0]!), "utf8");
      const entry = JSON.parse(content.trim());
      expect(entry.level).toBe(LogLevelName[LogLevel.Error]);
      expect(DiagnosticRecordSchema.parse(entry.diagnostic)).toMatchObject({ status: "error", phase: "end" });
      expect(entry).not.toHaveProperty("error");
      for (const unsafe of ["secret-value", "ZCODE_API_KEY", "missing an API key", "Turn execution failed"])
        expect(content).not.toContain(unsafe);
    } finally {
      await factory.flush();
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("cleans only zcode JSONL logs older than the retention window", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-retention-"));

    try {
      await Promise.all([
        writeFile(join(logDir, "zcode-2026-05-01.jsonl"), "old\n"),
        writeFile(join(logDir, "zcode-2026-05-02.jsonl"), "cutoff\n"),
        writeFile(join(logDir, "zcode-2026-05-08.jsonl"), "today\n"),
        writeFile(join(logDir, "zcode-2026-04-30.txt"), "other\n"),
        writeFile(join(logDir, "other-2026-04-30.jsonl"), "other\n"),
      ]);

      const result = await cleanupLogRetention({
        logDir,
        now: new Date(2026, 4, 8, 12, 0, 0),
      });

      await expect(readdir(logDir).then((files) => files.sort())).resolves.toEqual([
        "other-2026-04-30.jsonl",
        "zcode-2026-04-30.txt",
        "zcode-2026-05-02.jsonl",
        "zcode-2026-05-08.jsonl",
      ]);
      expect(result).toMatchObject({
        cutoffDate: "2026-05-02",
        deletedFiles: ["zcode-2026-05-01.jsonl"],
        failedFiles: [],
        retentionDays: 7,
        scannedFiles: 3,
        status: "completed",
      });
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("schedules retention cleanup once with the startup delay and unrefs the timer", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-schedule-"));
    const factory = createNodeLoggerFactory({ logDir });
    const timer = {
      unrefCalls: 0,
      unref() {
        this.unrefCalls += 1;
      },
    };
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];

    try {
      const first = factory.scheduleLogRetentionCleanup({
        setTimeout(callback, delayMs) {
          scheduled.push({ callback, delayMs });
          return timer;
        },
      });
      const second = factory.scheduleLogRetentionCleanup({
        setTimeout(callback, delayMs) {
          scheduled.push({ callback, delayMs });
          return timer;
        },
      });

      expect(first).toBe(timer);
      expect(second).toBeUndefined();
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.delayMs).toBe(LOG_CLEANUP_STARTUP_DELAY_MS);
      expect(timer.unrefCalls).toBe(1);
    } finally {
      await factory.flush();
      await rm(logDir, { recursive: true, force: true });
    }
  });
});
