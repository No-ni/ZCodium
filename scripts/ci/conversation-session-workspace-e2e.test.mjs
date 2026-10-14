/* eslint-disable max-lines -- 本文件是「对话会话独立工作目录」唯一的进程级 E2E 入口（单元级入口是
   conversation-session-workspace.test.mjs）。它必须自带一整套真实子进程驱动：spawn CLI、NDJSON
   握手、反向请求应答、v4 命令信封、订阅帧收集、sqlite 直读与临时目录回收。这些样板被「创建 /
   持久化」「重启后恢复」「不启用回落」三组场景共用同一份前置，拆成多个文件只会把约 400 行握手
   逻辑复制多份，或提前抽出一个并无第二用途的驱动模块；真正拆分时按「创建与持久化」/「恢复与快照」
   两个主题各建一个 test.mjs，并把驱动下沉到 scripts/ci/fixtures。 */
// 对话会话独立工作目录 —— 真实进程级 E2E 验收。
//
// 规格：docs/specs/conversation-session-workspace.md（验收 1/2/3 与「事件顺序」）。
// 这里不 mock 会话所有者：**起真的 Agent CLI 进程**（app-server --stdio），走真实
// NDJSON ZCode Protocol 握手与 v4 命令通道，再直接读 CLI 自己的 sqlite 会话库核对持久化事实。
//
// 安全边界（硬要求）：
// - `HOME` 与 `ZCODE_DATA_BASE_DIR` 都指向 mkdtemp 出来的临时目录。两个都必须改：
//   CLI 的默认会话库路径按 `homedir()/.zcodium/cli/db/db.sqlite` 解析
//   （apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts:8），
//   只改 ZCODE_DATA_BASE_DIR 仍会打开真实用户库；`ZCODE_SESSION_DB_PATH`
//   （apps/zcode-cli/packages/adapters/src/config/env-config.adapter.ts:31）再把库文件钉死在临时目录。
// - 不依赖网络、不请求真实模型：本测试不提交 prompt（模型调用才需要 provider）。
//   需要一条**已持久化**会话行时走导入历史路径（server-operations.ts:1120），它不执行模型。
// - 无论成功失败都杀子进程并删临时目录；失败诊断只打印协议形状与相对路径，不回显用户真实路径。
//
// 协议逐字形状（读源码确认，不凭描述猜）：
// - 请求/响应：`{id, method, params}` / `{id, result}` / `{id, error}`；
//   没有 `jsonrpc` 字段——packages/shared/src/zcode-protocol/index.ts:295 的
//   zcodeProtocolRequestSchema 是 strict，带 jsonrpc 会被 -32600 拒绝。
// - 启动握手：子进程先发 `{"method":"startup/storageState","params":{...,"phase":"checking"}}`，
//   直到 `phase:"ready"`（apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts:39）。
//   它还会反向请求 Host：`{"id":"server-N","method":"session/requestRuntimePreferences",...}`，
//   必须应答 `{nativeSearchEnhancementsEnabled, memoryEnabled}`，否则 15s 超时后建会话失败
//   （server-operations.ts:3217）。
// - 建会话：`v4/command`（V4_METHODS.command，packages/shared/src/zcode-protocol-v4/transport.ts:382），
//   params 就是命令信封本身（command.ts:326 commandEnvelopeSchema；V4Gateway.handleCommand
//   直接收信封，v4-gateway.ts:2385）。新会话 id 在 ACK 的 `result.result.sessionId`
//   （command.ts:388 commandResultSchema）。
// - 冷恢复：`session/resume`（zcodeProtocolMethods.sessionResume，server-operations.ts:1567）
//   与 `v4/conversation/subscribe`（V4_METHODS.conversationSubscribe）都汇到
//   v4-bridge.ts:1447 resumePersistedSession → server-operations.ts:1484
//   resolveConversationSessionWorkspaceForResume。

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
/**
 * CLI 入口与启动方式。
 *
 * 用 `node --import tsx` 而不是 `node_modules/.bin/tsx`：后者自身是个包装进程，会再 spawn 一个
 * 真正的 node 子进程（实测 `child.kill()` 只杀掉包装进程，真正的 CLI 还活着并继续往临时目录写
 * 日志），既让「杀子进程 + 清理临时目录」这条硬要求不可靠，也让退出码/生命周期观测错位。
 * 单进程启动后 `child.pid` 就是 CLI 本身。
 */
const CLI_ENTRY = resolve(REPO_ROOT, "apps", "zcode-cli", "packages", "cli", "src", "main.ts");
const TSX_LOADER = import.meta.resolve("tsx");

/** Host → Agent 的对话根标记（packages/shared/src/node/conversationWorkspaceEnv.ts:13）。 */
const CONVERSATION_WORKSPACE_ROOT_ENV = "ZCODE_CONVERSATION_WORKSPACE_ROOT";
/** 数据根重定向；CLI 的 session 库仍按 homedir，因此 HOME 也要重定向。 */
const DATA_BASE_DIR_ENV = "ZCODE_DATA_BASE_DIR";
const SESSION_DB_PATH_ENV = "ZCODE_SESSION_DB_PATH";

const STARTUP_STORAGE_STATE_METHOD = "startup/storageState";
const RUNTIME_PREFERENCES_REQUEST = "session/requestRuntimePreferences";
const SESSION_CREATE_METHOD = "session/create";
const SESSION_RESUME_METHOD = "session/resume";
const SESSION_LIST_METHOD = "session/list";
const SESSION_READ_METHOD = "session/read";
/** 旧协议的会话关闭（兼容删除 / 草稿丢弃 / 草稿预热失效都走它，与 v4 deleteSession 双入口）。 */
const SESSION_CLOSE_METHOD = "session/close";
const SESSION_FORK_METHOD = "session/fork";
const V4_COMMAND_METHOD = "v4/command";
const V4_CONVERSATION_FRAME = "v4/conversation/frame";
const V4_CONVERSATION_SUBSCRIBE_METHOD = "v4/conversation/subscribe";

test("A20/规则8：常驻父会话叶目录被占位后 fork 降级落盘且不跟随链接", async () => {
  for (const kind of ["file", "symlink"]) {
    await withCliProcess({ label: `a20-${kind}`, injectConversationRoot: true }, async (cli) => {
      const sessionId = await cli.createPersistedSession({ workspacePath: cli.conversationRoot });
      const seedRow = await cli.waitForSessionRow(sessionId);
      const read = await cli.request(SESSION_READ_METHOD, { sessionId });
      assert.equal(read.error, undefined);
      const messageId = read.result?.messages?.[0]?.info?.messageId;
      assert.ok(messageId, "导入的父会话必须有可分叉的消息");
      await rm(seedRow.path, { recursive: true });
      const outside = join(cli.root, "outside");
      await mkdir(outside);
      if (kind === "file") await writeFile(seedRow.path, "user-owned");
      else await symlink(outside, seedRow.path, "dir");
      const fork = await cli.request(SESSION_FORK_METHOD, {
        sessionId,
        target: { kind: "message", messageId },
      });
      assert.equal(fork.error, undefined, `fork 不得因占位失败: ${JSON.stringify(fork.error)}`);
      assert.equal(cli.readSessionRow(fork.result?.forkedSessionId)?.path, cli.conversationRoot);
      assert.deepEqual(await readdir(outside), [], "fork 不得跟随链接铸造目录");
      if (kind === "file") assert.equal(await readFile(seedRow.path, "utf8"), "user-owned");
      else assert.equal((await lstat(seedRow.path)).isSymbolicLink(), true);
    });
  }
});

/** 起进程 + 握手 + 建会话的预算：实测冷启动 2-3s，留足余量但绝不无限等。 */
const STARTUP_TIMEOUT_MS = 90_000;
const RPC_TIMEOUT_MS = 60_000;
const PROCESS_EXIT_TIMEOUT_MS = 10_000;

const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SESSION_ID_PREFIX = "sess_";
/** 目录名 = 会话 id（`sess_<uuid>`）去前缀后的前 8 位（规格「目录布局」）。 */
const SESSION_DIR_NAME_LENGTH = 8;

function localDateDirName(timestampMs = Date.now()) {
  const date = new Date(timestampMs);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function sessionDirName(sessionId, length = SESSION_DIR_NAME_LENGTH) {
  const normalized = String(sessionId)
    .replace(/^sess_/u, "")
    .replace(/[^a-z0-9]/giu, "");
  return normalized.slice(0, length).toLowerCase();
}

let commandSeq = 0;
function nextCommandId(type) {
  commandSeq += 1;
  return `ci-conversation-session-workspace-${type}-${process.pid}-${commandSeq}`;
}

function createCommandEnvelope(type, payload) {
  return {
    commandId: nextCommandId(type),
    clientId: "ci-conversation-session-workspace",
    // createSession 时为 null（command.ts:331）。
    sessionId: null,
    type,
    payload,
    // 客户端时钟，毫秒数（timestampSchema）。
    issuedAt: Date.now(),
  };
}

/** 杀 CLI 进程（含其子进程组）。负 pid 组信号只在类 Unix 生效，失败时回退单进程 kill。 */
function killProcessTree(child) {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // 进程组不存在或已退出：回退到单进程 kill。
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 已经退出。
  }
}

/** 本文件创建过的临时数据根；after() 用它把「临时目录清理」变成可验证的断言。 */
const createdTempRoots = new Set();

/**
 * 子进程刚被杀时 CLI 可能仍在写 log/插件缓存，rm 会 ENOTEMPTY；有限重试。
 * 进程组信号已经收掉了 CLI 及其子进程，这里只兜「写完最后一行日志」的窗口。
 */
async function cleanupDirectory(directory) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      createdTempRoots.delete(directory);
      return;
    } catch (error) {
      if (attempt === 11) {
        // 清理失败不能盖过断言结果，但要留下痕迹（只写错误码，不写绝对路径）。
        process.stderr.write(
          `[conversation-session-workspace-e2e] temp cleanup failed: ${error?.code}\n`,
        );
        return;
      }
      await delay(250);
    }
  }
}

/** 测试结束（含失败路径）不得留下临时目录：由 after() 统一断言。 */
after(async () => {
  const leaked = [...createdTempRoots];
  for (const directory of leaked) await cleanupDirectory(directory);
  assert.deepEqual(
    leaked.length,
    0,
    `临时目录未清理干净（泄漏 ${leaked.length} 个；名字形如 zcodium-conversation-ws-*）`,
  );
});

class CliProcess {
  #child;
  #buffer = "";
  #nextRequestId = 1;
  #pending = new Map();
  #stderr = "";
  #stdoutLines = 0;
  #notifications = [];
  #postResponseMessages = [];
  #exchangeError;
  #exited;
  #resolveExit;
  #exitSummary;
  #storageState = { phase: undefined, failure: undefined };
  #stopped = false;
  #ownsRoot = true;

  constructor({ child, root, sessionDbPath, conversationRoot }) {
    this.#child = child;
    this.root = root;
    this.sessionDbPath = sessionDbPath;
    this.conversationRoot = conversationRoot;
    this.#exited = new Promise((resolveExit) => {
      this.#resolveExit = resolveExit;
    });
    child.on("exit", (code, signal) => {
      this.#exitSummary = `code=${code ?? "null"}, signal=${signal ?? "none"}`;
      this.#resolveExit();
    });
    child.on("error", (error) => this.#recordExchangeError(error));
    child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.#stderr += chunk.toString();
      if (this.#stderr.length > 200_000) this.#stderr = this.#stderr.slice(-100_000);
    });
  }

  /** 诊断用：只保留协议形状与状态，不回显临时目录之外的绝对路径。 */
  diagnostics() {
    const stderrTail = this.#stderr.trim().split("\n").slice(-15).join("\n");
    return [
      `storage.phase=${this.#storageState.phase ?? "(none)"}`,
      this.#storageState.failure
        ? `storage.failure=${JSON.stringify(this.#storageState.failure)}`
        : undefined,
      `stdoutLines=${this.#stdoutLines}`,
      `notifications=${this.#notifications.length}`,
      this.#exchangeError ? `exchangeError=${this.#exchangeError}` : undefined,
      stderrTail ? `stderr(last lines):\n${stderrTail}` : "stderr=(empty)",
    ]
      .filter(Boolean)
      .join("\n");
  }

  #recordExchangeError(error) {
    if (this.#exchangeError) return;
    this.#exchangeError = error instanceof Error ? error.message : String(error);
    for (const pending of this.#pending.values()) pending.reject(new Error(this.#exchangeError));
    this.#pending.clear();
  }

  #onStdout(chunk) {
    this.#buffer += chunk.toString();
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex).trim();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.length > 0) this.#handleLine(line);
      newlineIndex = this.#buffer.indexOf("\n");
    }
  }

  #handleLine(line) {
    this.#stdoutLines += 1;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const id = message?.id;
    if (typeof message?.method === "string") {
      if (id !== undefined && this.#pending.has(id)) {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        pending.resolve(message);
        return;
      }
      if (id !== undefined) {
        // 反向请求（CLI → Host）：必须应答，否则会话物化会 15s 超时。
        this.#answerHostRequest(id, message.method);
        this.#notifications.push(message);
        return;
      }
      if (message.method === STARTUP_STORAGE_STATE_METHOD) {
        this.#storageState.phase = message.params?.phase;
        if (message.params?.phase === "failed") this.#storageState.failure = message.params;
      }
      this.#notifications.push(message);
      return;
    }
    if (id !== undefined && this.#pending.has(id)) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      pending.resolve(message);
    }
  }

  #answerHostRequest(id, method) {
    const reply =
      method === RUNTIME_PREFERENCES_REQUEST
        ? { id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false } }
        : { id, error: { code: -32601, message: `unsupported host request: ${method}` } };
    try {
      this.#child.stdin.write(`${JSON.stringify(reply)}\n`);
    } catch (error) {
      this.#recordExchangeError(error);
    }
  }

  request(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(
          new Error(
            `ZCode Protocol request timed out after ${timeoutMs}ms: ${method}\n${this.diagnostics()}`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          const from = this.#postResponseMessages.length;
          resolveRequest({
            result: message.result,
            error: message.error,
            // 同一 response 之后的 owned notification（subscribe 的 initial snapshot 走这里）。
            postResponse: () => this.#postResponseMessages.slice(from),
          });
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      try {
        this.#child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        rejectRequest(error);
      }
    });
  }

  async waitForStorageReady(timeoutMs = STARTUP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#storageState.phase === "ready") return;
      if (this.#storageState.phase === "failed") {
        throw new Error(
          `CLI storage startup failed: ${JSON.stringify(this.#storageState.failure)}\n${this.diagnostics()}`,
        );
      }
      if (this.#exchangeError) throw new Error(`CLI stdout failed: ${this.#exchangeError}`);
      if (this.#exitSummary) {
        throw new Error(
          `CLI exited before storage ready (${this.#exitSummary})\n${this.diagnostics()}`,
        );
      }
      await delay(50);
    }
    throw new Error(
      `CLI storage startup did not become ready in ${timeoutMs}ms\n${this.diagnostics()}`,
    );
  }

  /** v4 命令：params 就是信封本身；返回 CommandAck。 */
  async command(envelope) {
    const { result, error } = await this.request(V4_COMMAND_METHOD, envelope);
    assert.equal(error, undefined, `v4/command returned error: ${JSON.stringify(error)}`);
    assert.ok(result && typeof result === "object", "v4/command returned no CommandAck");
    return result;
  }

  /** 新建会话（v4 createSession，draft）。返回 ACK 与 ACK 里的 sessionId。 */
  async createSession({ workspaceId, firstInput }) {
    const ack = await this.command(
      createCommandEnvelope("createSession", {
        workspaceId,
        ...(firstInput ? { firstInput } : {}),
      }),
    );
    return { ack, sessionId: ack.result?.sessionId };
  }

  /**
   * 建一条**已持久化**的对话会话行，但不执行模型。
   *
   * 为什么走导入历史：v4 createSession 建出来的是 draft（persistence=deferred，不进 sqlite），
   * 而把 draft 提升为持久化会把会话推进真实模型 turn，本测试不请求模型。导入路径
   * （server-operations.ts:1120 起）把行写进 session 库，执行 cwd 仍由 createRecord 的
   * resolveRecordExecutionWorkspacePath 按同一规则铸造，因此覆盖的是同一契约。
   */
  async createPersistedSession({ sessionId, workspacePath }) {
    const { result, error } = await this.request(SESSION_CREATE_METHOD, {
      // 指定 id 只允许导入类创建：这是「幂等重试 / 删除后重新导入」的真实形态，
      // 会走 `resolveExistingPersistedExecutionPath`，即创建边界认持久化事实的那条支路。
      ...(sessionId === undefined ? {} : { sessionId }),
      workspace: { workspaceKey: workspacePath, workspacePath },
      persistence: "immediate",
      importedHistory: {
        source: "claudeCode",
        title: "conversation session workspace e2e",
        messages: [{ role: "user", content: "conversation session workspace e2e" }],
      },
    });
    assert.equal(error, undefined, `session/create returned error: ${JSON.stringify(error)}`);
    const createdSessionId = result?.messages?.[0]?.info?.sessionId;
    assert.ok(
      typeof createdSessionId === "string" && createdSessionId.startsWith(SESSION_ID_PREFIX),
      `session/create did not return a sessionId: ${JSON.stringify(result)?.slice(0, 300)}`,
    );
    if (sessionId !== undefined) {
      assert.equal(createdSessionId, sessionId, "带 sessionId 的导入创建必须复用同一个 id");
    }
    return createdSessionId;
  }

  /**
   * 冷订阅：ACK + 其后的 initial snapshot 帧。
   *
   * 时序逐字照实现：公共 response 严格只含 ACK，initial snapshot 由 server 的
   * request-scoped post-response outbox 在 **response line 之后**作为 owned notification 发出
   * （packages/shared/src/zcode-protocol-v4/transport.ts:440 附近的注释 + server.ts 的
   * `postResponseOutbox` / `takePostResponseBatch`）。所以帧必须**等**：先读 ACK，再等该 topic
   * 的 `v4/conversation/frame` 到达；这个等待有明确上界，不是无限等。
   */
  async subscribeConversation(sessionId, { frameTimeoutMs = 20_000 } = {}) {
    const framesBefore = this.#conversationFrameCount(sessionId);
    const reply = await this.request(V4_CONVERSATION_SUBSCRIBE_METHOD, {
      topic: `conversation/${sessionId}`,
      connectionId: `ci-conversation-session-workspace-${sessionId.slice(-6)}`,
      clientMode: "desktop-continuous",
      workspace: {
        workspaceKey: this.conversationRoot,
        workspacePath: this.conversationRoot,
      },
    });
    if (reply.error) {
      return { error: reply.error, ack: undefined, snapshot: undefined, frameCount: 0 };
    }
    const frames = await this.waitForConversationFrames(sessionId, {
      afterCount: framesBefore,
      timeoutMs: frameTimeoutMs,
    });
    const snapshot = frames
      .map((message) => message.params?.frame?.payload)
      .find((payload) => payload?.kind === "snapshot")?.snapshot;
    return { ack: reply.result?.ack, snapshot, frameCount: frames.length };
  }

  #conversationFrames(sessionId) {
    return this.#notifications.filter(
      (message) =>
        message.method === V4_CONVERSATION_FRAME &&
        message.params?.topic === `conversation/${sessionId}`,
    );
  }

  #conversationFrameCount(sessionId) {
    return this.#conversationFrames(sessionId).length;
  }

  /** 有界等待：initial frame 未到就返回已收到的部分，由调用方断言（不静默通过）。 */
  async waitForConversationFrames(sessionId, { afterCount = 0, timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frames = this.#conversationFrames(sessionId);
      if (frames.length > afterCount) return frames;
      if (this.#exchangeError) return this.#conversationFrames(sessionId);
      await delay(50);
    }
    return this.#conversationFrames(sessionId);
  }

  /** 旧协议冷恢复。返回 snapshot（server-operations.ts:1567 resumeSession）。 */
  async resumeSession(sessionId) {
    const { result, error } = await this.request(SESSION_RESUME_METHOD, { sessionId });
    return { error, snapshot: result };
  }

  async readSessionSnapshot(sessionId, messageLimit = 1) {
    const { result, error } = await this.request(SESSION_READ_METHOD, { sessionId, messageLimit });
    return { error, snapshot: result };
  }

  async listSessionsById(sessionId) {
    const { result, error } = await this.request(SESSION_LIST_METHOD, { sessionIds: [sessionId] });
    return { error, sessions: result?.sessions ?? [] };
  }

  /**
   * 诊断用：CLI 自己的 session 库读面（与本进程 `context.deps.sessionStore` 同一份配置）。
   *
   * 「冷恢复报 sessionNotFound」有两种成因——库根本没打开，或库打开了但看不到行。
   * 这条查询能把两者分开，失败信息里带上它就不必再猜。
   */
  async listStoredSessions() {
    const { result, error } = await this.request(
      SESSION_LIST_METHOD,
      { workspace: { workspaceKey: this.conversationRoot, workspacePath: this.conversationRoot } },
      RPC_TIMEOUT_MS,
    );
    if (error) return { error: `${error.code}: ${error.message}` };
    return { count: result?.sessions?.length ?? 0 };
  }

  readSessionRow(sessionId) {
    return readSessionRows(this.sessionDbPath, sessionId)[0];
  }

  async waitForSessionRow(sessionId, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const row = this.readSessionRow(sessionId);
        if (row) return row;
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw new Error(
      `session row was not persisted within ${timeoutMs}ms: ${maskSessionId(sessionId)}${
        lastError ? ` (last read error: ${lastError.message})` : ""
      }`,
    );
  }

  updateSessionPaths(sessionId, { path, directory }) {
    updateSessionPaths(this.sessionDbPath, sessionId, { path, directory });
  }

  /**
   * 放弃本进程对临时数据根的清理责任（下一个进程接管同一个 root）。
   * 不改进程生命周期，只影响 stop() 是否删目录。
   */
  releaseRoot() {
    this.#ownsRoot = false;
  }

  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    killProcessTree(this.#child);
    await Promise.race([this.#exited, delay(PROCESS_EXIT_TIMEOUT_MS)]);
    if (this.#ownsRoot) await cleanupDirectory(this.root);
  }
}

/**
 * 进程级 E2E 使用 CLI TypeScript 源入口；专用 tsconfig 把 bootstrap/core 包根映射到源码，
 * 其余依赖继续按 package exports 解析。
 */
function assertCliSourcePresent() {
  const sourceEntry = CLI_ENTRY;
  if (existsSync(sourceEntry)) return;
  throw new Error(`CLI 源码入口缺失：${relativeShape(REPO_ROOT, sourceEntry)}`);
}

async function startCliProcess({ label, injectConversationRoot, root: existingRoot }) {
  assertCliSourcePresent();
  const root = existingRoot ?? (await mkdtemp(join(tmpdir(), `zcodium-conversation-ws-${label}-`)));
  createdTempRoots.add(root);
  const conversationRoot = join(root, ".zcodium", "workspace", "default");
  // 真实 Host 也是先 ensureConversationWorkspace() 建好对话根再 spawn。
  await mkdir(conversationRoot, { recursive: true });
  const sessionDbPath = join(root, "session-db", "db.sqlite");

  const env = {
    ...process.env,
    // HOME 与数据根都重定向到临时目录：见文件头「安全边界」。
    HOME: root,
    [DATA_BASE_DIR_ENV]: root,
    [SESSION_DB_PATH_ENV]: sessionDbPath,
    TSX_TSCONFIG_PATH: join(
      REPO_ROOT,
      "scripts",
      "ci",
      "tsconfig.conversation-workspace-tests.json",
    ),
  };
  delete env[CONVERSATION_WORKSPACE_ROOT_ENV];
  if (injectConversationRoot) env[CONVERSATION_WORKSPACE_ROOT_ENV] = conversationRoot;

  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, CLI_ENTRY, "app-server", "--stdio"],
    {
      cwd: REPO_ROOT,
      env,
      // 独立进程组：SIGKILL 时连 CLI 可能派生出的子进程（插件宿主等）一起收掉，
      // 避免它们继续往临时目录写文件导致清理 ENOTEMPTY。Windows 不支持负 pid 组信号，
      // killTree 里对失败做了回退。
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return new CliProcess({ child, root, sessionDbPath, conversationRoot });
}

async function runBareResumePrompt({
  root,
  conversationRoot,
  sessionDbPath,
  sessionId,
  providerConfigPath,
}) {
  const env = {
    ...process.env,
    HOME: root,
    [DATA_BASE_DIR_ENV]: root,
    [SESSION_DB_PATH_ENV]: sessionDbPath,
    [CONVERSATION_WORKSPACE_ROOT_ENV]: conversationRoot,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerConfigPath,
    TSX_TSCONFIG_PATH: join(
      REPO_ROOT,
      "scripts",
      "ci",
      "tsconfig.conversation-workspace-tests.json",
    ),
  };
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)/iu.test(key)) delete env[key];
  }
  const child = spawn(
    process.execPath,
    [
      "--import",
      TSX_LOADER,
      CLI_ENTRY,
      "--resume",
      sessionId,
      "--prompt",
      "workspace guard fixture",
    ],
    {
      cwd: conversationRoot,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, 30_000);
  try {
    const outcome = await new Promise((resolveOutcome, rejectOutcome) => {
      child.once("error", rejectOutcome);
      child.once("close", (code, signal) => resolveOutcome({ code, signal }));
      child.stdin.end();
    });
    return { ...outcome, stderr, stdout, timedOut };
  } finally {
    clearTimeout(timeout);
  }
}

async function withCliProcess(options, fn) {
  const cli = await startCliProcess(options);
  try {
    await cli.waitForStorageReady();
    return await fn(cli);
  } finally {
    await cli.stop();
  }
}

/**
 * 「CLI 重启后打开旧会话」的真实验收骨架。
 *
 * 冷恢复只在**会话不在内存注册表**时才发生，所以必须在重启后的新进程里恢复：
 * 种子进程建会话 → SIGKILL 杀掉 → 同一个临时数据根起新进程 → 恢复。
 * 用 SIGKILL 结束正是崩溃/强制退出形态，会话库必须自己能恢复。
 *
 * 回调拿到的 `cli` 是重启后的进程（`restarted: true`）；`root` 是同一个临时数据根。
 */
async function withRestartedCliProcess(
  { label, injectConversationRoot = true, resumeInjectConversationRoot = injectConversationRoot },
  fn,
) {
  const seed = await startCliProcess({ label: `${label}-seed`, injectConversationRoot });
  let root;
  let sessionId;
  let seedRow;
  try {
    await seed.waitForStorageReady();
    root = seed.root;
    sessionId = await seed.createPersistedSession({ workspacePath: seed.conversationRoot });
    seedRow = await seed.waitForSessionRow(sessionId);
    // Ownership transfers only after the seed is usable; startup failures must clean their own root.
    seed.releaseRoot();
  } finally {
    await seed.stop();
  }

  // 重启后的进程可以换一个「是否注入标记」的形态：回滚态、CLI/TUI 独立运行都要能读已经迁移过的行。
  const resume = await startCliProcess({
    label: `${label}-resume`,
    injectConversationRoot: resumeInjectConversationRoot,
    root,
  });
  try {
    await resume.waitForStorageReady();
    return await fn({ cli: resume, sessionId, seedRow, root });
  } finally {
    await resume.stop();
  }
}

function maskSessionId(sessionId) {
  return `${String(sessionId).slice(0, 13)}…`;
}

function relativeShape(root, absolutePath) {
  if (typeof absolutePath !== "string" || absolutePath.length === 0) return String(absolutePath);
  return absolutePath.startsWith(root)
    ? `<TEMP>${absolutePath.slice(root.length)}`
    : "<outside-temp>";
}

function formatRow(root, row) {
  if (!row) return "(no session row)";
  return JSON.stringify(
    {
      id: maskSessionId(row.id),
      directory: relativeShape(root, row.directory),
      path: relativeShape(root, row.path),
      workspace_id: row.workspace_id ?? null,
      task_type: row.task_type,
    },
    undefined,
    0,
  );
}

async function readDateDirectories(conversationRoot) {
  const entries = await readdir(conversationRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && DATE_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readSessionDirNames(conversationRoot, dateDirName) {
  const entries = await readdir(join(conversationRoot, dateDirName), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function readSessionRows(dbPath, sessionId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "select id, directory, path, workspace_id, project_id, task_type, time_created from session where id = ?",
      )
      .all(sessionId);
  } finally {
    db.close();
  }
}

/**
 * session 表的真实列名集合。机制用例用它断言「本规则依赖的五列确实在 schema 里」——
 * 早先版本改成断言 `column in row`，而 row 来自测试自己的 SELECT（列名由那条 SQL 决定），
 * 于是断言恒真：schema 里真删掉 `path` 也不会红。
 */
function readSessionTableColumns(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("select name from pragma_table_info('session')")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function updateSessionPaths(dbPath, sessionId, { path, directory }) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("update session set path = ?, directory = ? where id = ?").run(
      path,
      directory,
      sessionId,
    );
  } finally {
    db.close();
  }
}

function persistSessionModelSelection(dbPath, sessionId) {
  const db = new DatabaseSync(dbPath);
  const now = Date.now();
  try {
    db.prepare(
      "insert into session_entry (id, session_id, type, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(),
      sessionId,
      "runtime/model_selection",
      now,
      now,
      JSON.stringify({
        modelSelection: {
          providerId: "fixture-api",
          modelId: "fixture-model",
          options: { reasoningLevel: "disabled" },
        },
      }),
    );
  } finally {
    db.close();
  }
}

/**
 * 从持久化行判断「本进程是否对该会话启用了独立目录规则」。
 *
 * 这是**运行时探测**，不是断言放宽：标记生效时会话执行 cwd 必须落在对话根之下（新行为），
 * 未生效时必须等于对话根（旧行为）。两条路径都有写死的断言，因此实现未落地时是真红。
 */
function observeSessionWorkspace(cli, sessionId, row) {
  const executionCwd = row?.path ?? undefined;
  const workspaceKeyPath = row?.directory ?? cli.conversationRoot;
  const insideConversationRoot =
    typeof executionCwd === "string" &&
    executionCwd !== workspaceKeyPath &&
    (executionCwd.startsWith(`${cli.conversationRoot}/`) ||
      executionCwd.startsWith(`${cli.conversationRoot}\\`));
  return { sessionId, executionCwd, workspaceKeyPath, insideConversationRoot };
}

test("机制：真实 CLI 进程可握手、可建会话，且 session 表具备本规则依赖的列（值非空）", async () => {
  await withCliProcess({ label: "mech", injectConversationRoot: true }, async (cli) => {
    const draft = await cli.createSession({ workspaceId: cli.conversationRoot });
    assert.equal(draft.ack.status, "accepted", `createSession ACK: ${JSON.stringify(draft.ack)}`);
    assert.match(
      String(draft.sessionId),
      /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      "v4 createSession ACK 必须给出 CLI 铸造的 sessionId",
    );

    const persistedId = await cli.createPersistedSession({ workspacePath: cli.conversationRoot });
    const row = await cli.waitForSessionRow(persistedId);
    // 列名必须来自 schema 本身（pragma），不能拿测试自己的 SELECT 结果当证据。
    const columns = readSessionTableColumns(cli.sessionDbPath);
    for (const column of ["id", "directory", "path", "workspace_id", "project_id", "task_type"]) {
      assert.ok(
        columns.includes(column),
        `session 表必须有 ${column} 列（schema 实际列: ${columns.join(",")}）`,
      );
    }
    for (const column of ["directory", "path"]) {
      assert.equal(
        typeof row[column],
        "string",
        `${column} 必须是字符串（实际: ${formatRow(cli.root, row)}）`,
      );
      assert.ok(
        row[column].length > 0,
        `${column} 不得为空串（实际: ${formatRow(cli.root, row)}）`,
      );
    }
    assert.match(String(row.id), /^sess_/u);
    assert.equal(
      row.workspace_id,
      null,
      `本地对话会话的 workspace_id 必须为空：${formatRow(cli.root, row)}`,
    );
  });
});

test("A1/验收1-2：注入标记后建两个会话 → id 不同、目录 = <根>/<创建日>/<id前8位>、两目录不同", async () => {
  await withCliProcess({ label: "a1", injectConversationRoot: true }, async (cli) => {
    const first = await cli.createSession({ workspaceId: cli.conversationRoot });
    const second = await cli.createSession({ workspaceId: cli.conversationRoot });

    assert.equal(
      first.ack.status,
      "accepted",
      `第一个 createSession ACK: ${JSON.stringify(first.ack)}`,
    );
    assert.equal(
      second.ack.status,
      "accepted",
      `第二个 createSession ACK: ${JSON.stringify(second.ack)}`,
    );
    assert.notEqual(first.sessionId, second.sessionId, "两次 ACK 的 sessionId 必须不同");

    // 日期段由 CLI 用自己的 `Date.now()` 铸造：这里从文件系统**读出**它，而不是在测试进程里
    // 另算一个「今天」——两个时钟跨零点会差一天，断言会在没有任何代码改动的情况下变红
    //（规格口径本来就是「创建日」，不是「测试跑的那一天」）。
    const dateDirs = await readDateDirectories(cli.conversationRoot);
    assert.equal(
      dateDirs.length,
      1,
      `对话根下应只有本次创建的日期目录（不得有残留日期目录），实际: ${JSON.stringify(dateDirs)}`,
    );
    const today = dateDirs[0];
    assert.match(String(today), DATE_DIR_PATTERN, `日期目录名必须是 <YYYY-MM-DD>，实际: ${today}`);

    const expected = [sessionDirName(first.sessionId), sessionDirName(second.sessionId)].sort();
    const actual = await readSessionDirNames(cli.conversationRoot, today);
    assert.notEqual(expected[0], expected[1], "两个会话的目录名必须不同");
    assert.deepEqual(
      actual,
      expected,
      `日期目录下的会话目录名必须等于 ACK sessionId 去 sess_ 前缀后的前 8 位（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
    );
    for (const name of actual) {
      assert.match(name, /^[0-9a-z]{8}$/u, `会话目录名形状必须是 8 位小写字母数字: ${name}`);
      assert.ok(
        await pathExists(join(cli.conversationRoot, today, name)),
        `会话目录必须真实存在: ${today}/${name}`,
      );
    }
  });
});

test("A2/验收3：持久化行 directory = 对话根、path = 会话目录、workspace_id 为空", async () => {
  await withCliProcess({ label: "a2", injectConversationRoot: true }, async (cli) => {
    const sessionId = await cli.createPersistedSession({ workspacePath: cli.conversationRoot });
    const row = await cli.waitForSessionRow(sessionId);
    const observed = observeSessionWorkspace(cli, sessionId, row);

    assert.equal(
      observed.workspaceKeyPath,
      cli.conversationRoot,
      `directory 必须是工作区键路径（对话根），实际行: ${formatRow(cli.root, row)}`,
    );
    assert.equal(
      row.workspace_id,
      null,
      `本地对话会话不得把对话根写成身份（workspace_id 应为 null），实际行: ${formatRow(cli.root, row)}`,
    );
    assert.equal(
      observed.insideConversationRoot,
      true,
      `注入 ${CONVERSATION_WORKSPACE_ROOT_ENV} 后 path 必须是对话根之下的会话目录，实际行: ${formatRow(cli.root, row)}`,
    );

    const expectedDateDir = localDateDirName(row.time_created ?? Date.now());
    assert.equal(
      row.path,
      join(cli.conversationRoot, expectedDateDir, sessionDirName(sessionId)),
      `<根>/<创建日>/<id前8位> 不匹配，实际行: ${formatRow(cli.root, row)}`,
    );
  });
});

test("A3/验收3：CLI 重启后，会话目录被手工删除时冷订阅按持久化 path 重建", async () => {
  await withRestartedCliProcess({ label: "a3" }, async ({ cli, sessionId, seedRow, root }) => {
    const sessionDirectory = seedRow.path;
    assert.equal(
      observeSessionWorkspace(cli, sessionId, seedRow).insideConversationRoot,
      true,
      `前置条件：会话执行 cwd 必须落在对话根下，实际行: ${formatRow(root, seedRow)}`,
    );
    assert.ok(await pathExists(sessionDirectory), "前置条件：新建会话目录真实存在");

    // 手工删除会话目录（模拟用户清理），再冷恢复：目录必须被重建。
    await rm(sessionDirectory, { recursive: true, force: true });
    assert.equal(await pathExists(sessionDirectory), false, "前置条件：会话目录已删除");

    const outcome = await cli.subscribeConversation(sessionId);
    if (outcome.error) {
      const stored = await cli.listStoredSessions();
      assert.fail(
        `冷订阅必须能恢复持久化会话，实际错误: ${JSON.stringify(outcome.error)}；` +
          `CLI 自己读 session 库: ${JSON.stringify(stored)}`,
      );
    }
    assert.ok(outcome.ack, "冷订阅必须返回 ACK");
    assert.equal(
      await pathExists(sessionDirectory),
      true,
      `冷恢复后必须按持久化 path 重建会话目录: ${relativeShape(root, sessionDirectory)}`,
    );
    // 恢复不得改写持久化事实。
    const rowAfter = cli.readSessionRow(sessionId);
    assert.equal(rowAfter?.path, sessionDirectory, "恢复后 path 不得漂移");
    assert.equal(
      rowAfter?.directory,
      cli.conversationRoot,
      `恢复后 directory 仍是对话根，实际行: ${formatRow(root, rowAfter)}`,
    );
  });
});

test("A3-入口二/验收3：旧协议 session/resume 同样按持久化 path 重建目录", async () => {
  await withRestartedCliProcess(
    { label: "a3-legacy" },
    async ({ cli, sessionId, seedRow, root }) => {
      const sessionDirectory = seedRow.path;
      await rm(sessionDirectory, { recursive: true, force: true });
      assert.equal(await pathExists(sessionDirectory), false, "前置条件：会话目录已删除");

      const outcome = await cli.resumeSession(sessionId);
      assert.equal(
        outcome.error,
        undefined,
        `session/resume 必须能恢复持久化会话，实际错误: ${JSON.stringify(outcome.error)}`,
      );
      assert.equal(
        await pathExists(sessionDirectory),
        true,
        `session/resume 必须重建会话目录: ${relativeShape(root, sessionDirectory)}`,
      );
      assert.equal(
        cli.readSessionRow(sessionId)?.path,
        sessionDirectory,
        "session/resume 不得改写持久化 path",
      );
      assert.equal(
        outcome.snapshot?.session?.executionWorkspacePath,
        sessionDirectory,
        "session/resume 的 session 投影必须等于持久化执行 cwd",
      );
    },
  );
});

test("A3b/验收4：存量会话（path = 对话根）在重启后首次恢复补发目录，日期取会话自身创建日", async () => {
  await withRestartedCliProcess({ label: "a3b" }, async ({ cli, sessionId, seedRow, root }) => {
    const backfilledDirectory = join(
      cli.conversationRoot,
      localDateDirName(seedRow.time_created),
      sessionDirName(sessionId),
    );

    // 把行改回存量形态：path 仍等于对话根（本改动之前创建的老会话）。
    cli.updateSessionPaths(sessionId, {
      path: cli.conversationRoot,
      directory: cli.conversationRoot,
    });
    await rm(backfilledDirectory, { recursive: true, force: true });

    const outcome = await cli.subscribeConversation(sessionId);
    if (outcome.error) {
      const stored = await cli.listStoredSessions();
      assert.fail(
        `存量会话恢复失败: ${JSON.stringify(outcome.error)}；CLI 自己读 session 库: ${JSON.stringify(stored)}`,
      );
    }
    assert.equal(
      await pathExists(backfilledDirectory),
      true,
      `存量会话必须补发 <根>/<该会话创建日>/<id前8位>: ${relativeShape(root, backfilledDirectory)}`,
    );
    const rowAfter = cli.readSessionRow(sessionId);
    // 诊断证据：补发目录已建、快照也认它是执行 cwd，但持久化 `path` 未随会话更新。
    // 只补发不落盘会让下一次恢复再次补发，且 core 的 resume 仍从旧行取 cwd
    // （core/src/runtime/methods/resume.ts 的 `this.workingDirectory = session.path ?? session.directory`），
    // 于是「存量会话落到补发目录」在运行时并不成立。
    const projectionEvidence = `snapshot.workspacePath=${String(outcome.snapshot?.workspacePath)}`;
    assert.equal(
      rowAfter?.path,
      backfilledDirectory,
      `补发结果必须随会话持久化（规格规则 4「补发只发生一次，随后随会话持久化」），` +
        `实际行: ${formatRow(root, rowAfter)}；${projectionEvidence}`,
    );
    assert.equal(rowAfter?.directory, cli.conversationRoot, "补发不得改写 directory");
  });
});

test("A4/验收6：不注入标记时保持旧行为 —— 对话根下不新建日期目录，存量文件不动", async () => {
  await withCliProcess({ label: "a4", injectConversationRoot: false }, async (cli) => {
    // 存量文件必须原样保留：旧行为不迁移、不重命名对话根下已有内容（规格规则 7）。
    await writeFile(join(cli.conversationRoot, "legacy-note.txt"), "kept\n");
    const before = (await readdir(cli.conversationRoot)).sort();

    const draft = await cli.createSession({ workspaceId: cli.conversationRoot });
    assert.equal(draft.ack.status, "accepted", `createSession ACK: ${JSON.stringify(draft.ack)}`);
    const draftRead = await cli.readSessionSnapshot(draft.sessionId);
    assert.equal(
      draftRead.error,
      undefined,
      `session/read error: ${JSON.stringify(draftRead.error)}`,
    );
    assert.equal(
      "executionWorkspacePath" in (draftRead.snapshot?.session ?? {}),
      false,
      "未启用独立目录规则时草稿 session 投影必须省略 executionWorkspacePath",
    );
    assert.deepEqual(
      await readDateDirectories(cli.conversationRoot),
      [],
      `未注入 ${CONVERSATION_WORKSPACE_ROOT_ENV} 时不得新建会话目录`,
    );
    assert.deepEqual(
      (await readdir(cli.conversationRoot)).sort(),
      before,
      "旧行为不得改写对话根下已有内容",
    );

    // 旧行为下会话执行 cwd = 对话根：持久化行必须保持 directory = path = 对话根。
    const persistedId = await cli.createPersistedSession({ workspacePath: cli.conversationRoot });
    const row = await cli.waitForSessionRow(persistedId);
    assert.equal(
      row.path,
      cli.conversationRoot,
      `未注入标记时 path 必须等于对话根（旧行为），实际行: ${formatRow(cli.root, row)}`,
    );
    const listed = await cli.listSessionsById(persistedId);
    assert.equal(listed.error, undefined, `session/list 精确 ID 查询失败: ${listed.error}`);
    assert.equal(listed.sessions.length, 1, "session/list 精确 ID 查询应返回持久化任务");
    assert.equal(
      "executionWorkspacePath" in listed.sessions[0],
      false,
      "未启用独立目录规则时持久化 session 投影必须省略 executionWorkspacePath",
    );
    assert.deepEqual(
      await readDateDirectories(cli.conversationRoot),
      [],
      "旧行为下建会话仍不得产生日期目录",
    );
  });
});

test("A5/接口：冷订阅 conversation 快照的 workspacePath = 会话执行 cwd", async () => {
  await withRestartedCliProcess({ label: "a5" }, async ({ cli, sessionId, seedRow, root }) => {
    assert.equal(
      observeSessionWorkspace(cli, sessionId, seedRow).insideConversationRoot,
      true,
      `前置条件：会话执行 cwd 必须已在对话根之下，实际行: ${formatRow(root, seedRow)}`,
    );

    const outcome = await cli.subscribeConversation(sessionId);
    if (outcome.error) {
      const stored = await cli.listStoredSessions();
      assert.fail(
        `冷订阅失败: ${JSON.stringify(outcome.error)}；CLI 自己读 session 库: ${JSON.stringify(stored)}`,
      );
    }
    assert.ok(
      outcome.snapshot,
      `冷订阅必须在 post-response 帧里给出 initial snapshot（frames=${outcome.frameCount}）`,
    );
    // additive 可选字段：缺席即「未落地」，这是真失败而不是跳过。
    assert.ok(
      "workspacePath" in outcome.snapshot,
      `snapshot 缺少 additive 字段 workspacePath（字段: ${Object.keys(outcome.snapshot).join(",")}）`,
    );
    assert.equal(
      outcome.snapshot.workspacePath,
      seedRow.path,
      `snapshot.workspacePath 必须等于会话执行 cwd（= 持久化 path），实际 snapshot.workspacePath=${String(
        outcome.snapshot.workspacePath,
      )}`,
    );
    assert.equal(outcome.snapshot.sessionId, sessionId, "snapshot.sessionId 必须是被订阅的会话");
    assert.equal(cli.readSessionRow(sessionId)?.path, seedRow.path, "冷订阅不得改写持久化 path");
  });
});

test("A5b/规则14-15：草稿读取与冷精确 ID 列表投影执行 cwd", async () => {
  await withCliProcess({ label: "a5b-draft", injectConversationRoot: true }, async (cli) => {
    const draft = await cli.createSession({ workspaceId: cli.conversationRoot });
    assert.equal(draft.ack.status, "accepted", `createSession ACK: ${JSON.stringify(draft.ack)}`);
    const read = await cli.readSessionSnapshot(draft.sessionId);
    assert.equal(read.error, undefined, `session/read error: ${JSON.stringify(read.error)}`);

    const expectedPath = join(
      cli.conversationRoot,
      (await readDateDirectories(cli.conversationRoot))[0],
      sessionDirName(draft.sessionId),
    );
    assert.equal(await pathExists(expectedPath), true, "草稿执行目录必须已存在");
    assert.equal(
      read.snapshot?.session?.executionWorkspacePath,
      expectedPath,
      "deferred 草稿的 session/read 必须投影 CLI 已分配的执行 cwd",
    );
  });

  await withRestartedCliProcess({ label: "a5b-list" }, async ({ cli, sessionId, seedRow }) => {
    const listed = await cli.listSessionsById(sessionId);
    assert.equal(listed.error, undefined, `session/list 精确 ID 查询失败: ${listed.error}`);
    assert.equal(listed.sessions.length, 1, "session/list 精确 ID 查询应返回持久化任务");
    assert.equal(
      listed.sessions[0]?.executionWorkspacePath,
      seedRow.path,
      "重启后的精确 ID 查询必须从持久化 path 投影执行 cwd",
    );
  });
});

test("A6/验收5：v4 deleteSession 回收草稿的空会话目录，且不留空日期目录", async () => {
  await withCliProcess({ label: "a6", injectConversationRoot: true }, async (cli) => {
    const draft = await cli.createSession({ workspaceId: cli.conversationRoot });
    assert.equal(draft.ack.status, "accepted", `createSession ACK: ${JSON.stringify(draft.ack)}`);
    const sessionId = String(draft.sessionId);
    // 日期段同样从文件系统读出（CLI 用自己的时钟铸，测试进程另算会跨零点差一天）。
    const draftDateDirs = await readDateDirectories(cli.conversationRoot);
    assert.equal(
      draftDateDirs.length,
      1,
      `草稿应建立唯一日期目录，实际: ${JSON.stringify(draftDateDirs)}`,
    );
    const draftDir = join(cli.conversationRoot, draftDateDirs[0], sessionDirName(sessionId));
    assert.equal(
      await pathExists(draftDir),
      true,
      `草稿建会话即应建立会话目录: ${relativeShape(cli.root, draftDir)}`,
    );

    const ack = await cli.command({
      ...createCommandEnvelope("deleteSession", {}),
      sessionId,
    });
    assert.equal(ack.status, "accepted", `deleteSession ACK: ${JSON.stringify(ack)}`);
    // 删除边界必须回收空目录（规格规则 8 / 验收 5）：接线只在单测里被直接调用过，
    // 删掉 v4-bridge closeSession 里那段回收调用不会有任何测试变红——这条就是补那个缺口。
    assert.equal(
      await pathExists(draftDir),
      false,
      `未使用的草稿目录必须在删除边界回收: ${relativeShape(cli.root, draftDir)}`,
    );
    assert.deepEqual(
      await readDateDirectories(cli.conversationRoot),
      [],
      "随之变空的日期目录也应一并回收",
    );
  });
});

test("A6b/验收3+5：旧 session/close 同样回收空目录，且再次恢复会按 path 重建", async () => {
  await withCliProcess({ label: "a6b", injectConversationRoot: true }, async (cli) => {
    const sessionId = await cli.createPersistedSession({ workspacePath: cli.conversationRoot });
    const row = await cli.waitForSessionRow(sessionId);
    const executionCwd = row.path;
    assert.equal(
      typeof executionCwd === "string" &&
        executionCwd !== cli.conversationRoot &&
        (executionCwd.startsWith(`${cli.conversationRoot}/`) ||
          executionCwd.startsWith(`${cli.conversationRoot}\\`)),
      true,
      `前置条件：会话执行 cwd 必须已在对话根之下，实际行: ${formatRow(cli.root, row)}`,
    );
    assert.equal(await pathExists(executionCwd), true, "建会话即应建立会话目录");

    // 旧 session/close 是兼容删除 / 草稿丢弃的活路径：回收不能只挂在 v4 deleteSession 上，
    // 否则这些路径留下的空目录要等 Host 下次启动的 7 天清扫。
    const closed = await cli.request(SESSION_CLOSE_METHOD, { sessionId });
    assert.equal(
      closed.error,
      undefined,
      `session/close returned error: ${JSON.stringify(closed.error)}`,
    );
    assert.equal(closed.result?.closed, true, "session/close 必须确认关闭");
    assert.equal(
      await pathExists(executionCwd),
      false,
      `空会话目录必须在旧 close 边界回收: ${relativeShape(cli.root, executionCwd)}`,
    );

    // 关闭不是改库：行仍指向会话目录，恢复时按持久化 path 重建（mkdir 幂等），不得漂移。
    const resumed = await cli.request(SESSION_RESUME_METHOD, { sessionId });
    assert.equal(
      resumed.error,
      undefined,
      `session/resume returned error: ${JSON.stringify(resumed.error)}`,
    );
    assert.equal(await pathExists(executionCwd), true, "恢复必须按持久化 path 重建会话目录");
    assert.equal(
      cli.readSessionRow(sessionId)?.path,
      executionCwd,
      `回收不得改写持久化 path，实际行: ${formatRow(cli.root, cli.readSessionRow(sessionId))}`,
    );
  });
});

test("A7：未注入标记但行已是会话目录 → 恢复仍按持久化 path 运行并投影它（回滚 / CLI-TUI 态不分叉）", async () => {
  await withRestartedCliProcess(
    { label: "a7", injectConversationRoot: true, resumeInjectConversationRoot: false },
    async ({ cli, sessionId, seedRow }) => {
      assert.equal(
        observeSessionWorkspace(cli, sessionId, seedRow).insideConversationRoot,
        true,
        `前置条件：种子行的执行 cwd 必须在对话根之下，实际行: ${formatRow(cli.root, seedRow)}`,
      );
      assert.equal(await pathExists(seedRow.path), true, "种子会话目录必须存在");

      const outcome = await cli.subscribeConversation(sessionId);
      if (outcome.error) {
        const stored = await cli.listStoredSessions();
        assert.fail(
          `未注入标记时冷订阅必须仍能恢复：${JSON.stringify(outcome.error)}；CLI 自读会话库: ${JSON.stringify(stored)}`,
        );
      }
      assert.ok(
        outcome.snapshot,
        `冷订阅必须给出 initial snapshot（frames=${outcome.frameCount}）`,
      );
      // 这条正是核心不变量：runtime 的执行 cwd 只来自持久化 path（core 的 resumeFromStore 用
      // session.path ?? session.directory）。bootstrap 若因为「没有标记」就回落 workspacePath，
      // 就会出现「Agent 在会话目录落盘、UI 文件树指向对话根」的分叉。
      assert.equal(
        outcome.snapshot.workspacePath,
        seedRow.path,
        `未注入标记时快照仍必须投影持久化 path（不能回落对话根），实际: ${String(
          outcome.snapshot.workspacePath,
        )}`,
      );
      assert.equal(cli.readSessionRow(sessionId)?.path, seedRow.path, "恢复不得改写持久化 path");
      // 未注入标记 ⇒ 不适用本规则的补发与回收：不能凭空多出一个日期目录/会话目录，也不能删掉它。
      const dateDirName = seedRow.path.split(/[\\/]/u).at(-2);
      assert.deepEqual(
        await readSessionDirNames(cli.conversationRoot, dateDirName),
        [sessionDirName(sessionId)],
        "未注入标记时不得新建或回收会话目录",
      );
      assert.equal(await pathExists(seedRow.path), true, "未注入标记时不得回收既有会话目录");
    },
  );
});

test("A8：带 sessionId 的导入创建二次执行复用既有行的执行 cwd（创建边界不重算目录）", async () => {
  await withCliProcess({ injectConversationRoot: true, label: "a8" }, async (cli) => {
    // 导入类创建是唯一允许客户端指定 sessionId 的入口，因此行可能已经存在（分享导入的幂等重试、
    // claude 导入的"幂等回填"、删除/归档后重新导入）。第二次创建给出的历史时间不同（模拟跨零点
    // 的重试）时，创建边界必须以**行里持久化的 path** 为准，否则 runtime 会落到另一个日期目录，
    // 而库里仍是旧值：这次会话写下的文件下次冷恢复就不属于它了。
    const sessionId = `${SESSION_ID_PREFIX}${randomUUID()}`;
    const createOnce = async (createdAt) => {
      const { result, error } = await cli.request(SESSION_CREATE_METHOD, {
        workspace: { workspaceKey: cli.conversationRoot, workspacePath: cli.conversationRoot },
        persistence: "immediate",
        sessionId,
        importedHistory: {
          source: "claudeCode",
          title: "re-create reuse e2e",
          createdAt,
          messages: [{ content: "re-create reuse e2e", role: "user", timestamp: createdAt }],
        },
      });
      assert.equal(error, undefined, `session/create returned error: ${JSON.stringify(error)}`);
      assert.equal(result?.messages?.[0]?.info?.sessionId, sessionId);
      return await cli.waitForSessionRow(sessionId);
    };

    const firstCreatedAt = Date.now() - 26 * 60 * 60 * 1000;
    const firstRow = await createOnce(firstCreatedAt);
    assert.equal(
      observeSessionWorkspace(cli, sessionId, firstRow).insideConversationRoot,
      true,
      `首次创建必须落在对话根之下，实际行: ${formatRow(cli.root, firstRow)}`,
    );
    const firstDirName = sessionDirName(sessionId);
    assert.equal(
      firstRow.path,
      join(cli.conversationRoot, localDateDirName(firstCreatedAt), firstDirName),
    );

    // 第二次：历史时间晚一天（跨零点重试）→ 目录日期段本会不同，但行的 path 必须不变。
    const secondRow = await createOnce(firstCreatedAt + 24 * 60 * 60 * 1000);
    assert.equal(
      secondRow.path,
      firstRow.path,
      `重复创建不得改写既有行的执行 cwd，实际行: ${formatRow(cli.root, secondRow)}`,
    );
    assert.equal(secondRow.directory, cli.conversationRoot, "工作区键路径也不得漂移");
    // 没有多出第二个会话目录：名字复用 + 创建边界认持久化事实，两侧都不该造新目录。
    assert.deepEqual(
      await readDateDirectories(cli.conversationRoot),
      [localDateDirName(firstCreatedAt)],
      "重复创建不得新建日期目录",
    );
    assert.deepEqual(
      await readSessionDirNames(cli.conversationRoot, localDateDirName(firstCreatedAt)),
      [firstDirName],
    );
  });
});

/**
 * A9（规格已知边界 11 的收紧）：8 位定名复用只对**自己**幂等。
 *
 * 修复前：`<日期>/<id8>` 只要是真目录就复用，于是同一天两个不同会话 id 撞前 8 位（2^-32）时
 * 共用同一个执行目录。CLI 进程内其实能分辨——同一 workspace 的在册会话都在 `context.sessions`
 * 注册表里，每个 record 带 `executionWorkspacePath`；创建边界把「别人的目录」当占用事实传入，
 * 撞位时回退 12 位名。
 *
 * 为什么两个 id 都走「带 importedHistory」的创建：协议只允许这条路径由客户端指定 sessionId
 * （普通 session/create 的 id 由 CLI 铸造，无法构造碰撞）。历史时间取同一时刻 ⇒ 同一个日期目录，
 * 碰撞必然发生。断言两个会话的 path 是两个不同目录（一个 8 位、一个 12 位），且快照投影的
 * workspacePath（= 传给 runtime 的 workingDirectory，即真实执行 cwd）与库里 path 一致。
 */
test("A9/边界11：前 8 位相同的两个会话必须落到两个不同目录（一个 8 位、一个 12 位）", async () => {
  await withCliProcess({ injectConversationRoot: true, label: "a9" }, async (cli) => {
    const firstSessionId = `${SESSION_ID_PREFIX}aaaaaaaa-1111-4111-8111-111111111111`;
    const secondSessionId = `${SESSION_ID_PREFIX}aaaaaaaa-2222-4222-8222-222222222222`;
    const firstShortName = sessionDirName(firstSessionId);
    assert.equal(
      firstShortName,
      sessionDirName(secondSessionId),
      "前置条件：两个会话 id 的前 8 位必须相同，否则这条用例证明不了碰撞回退",
    );
    const secondLongName = sessionDirName(secondSessionId, 12);

    const createdAt = Date.now();
    const createOnce = async (sessionId) => {
      const { result, error } = await cli.request(SESSION_CREATE_METHOD, {
        workspace: { workspaceKey: cli.conversationRoot, workspacePath: cli.conversationRoot },
        persistence: "immediate",
        sessionId,
        importedHistory: {
          source: "claudeCode",
          title: "8-hex-prefix collision e2e",
          createdAt,
          messages: [{ content: "8-hex-prefix collision e2e", role: "user", timestamp: createdAt }],
        },
      });
      assert.equal(error, undefined, `session/create returned error: ${JSON.stringify(error)}`);
      assert.equal(result?.messages?.[0]?.info?.sessionId, sessionId);
      return await cli.waitForSessionRow(sessionId);
    };

    const dateDirName = localDateDirName(createdAt);
    // 并发请求必须持有定名所有权至 record 注册；只查已注册 record 会同时复用 8 位目录。
    const [firstRow, secondRow] = await Promise.all([
      createOnce(firstSessionId),
      createOnce(secondSessionId),
    ]);
    // 第一个会话没有任何占用者 ⇒ 8 位名。
    assert.equal(
      firstRow.path,
      join(cli.conversationRoot, dateDirName, firstShortName),
      `首个会话必须落在 8 位目录，实际行: ${formatRow(cli.root, firstRow)}`,
    );

    // 第二个会话撞上前 8 位，且该目录属于**别的在册会话** ⇒ 回退 12 位，绝不共用目录。
    assert.equal(
      secondRow.path,
      join(cli.conversationRoot, dateDirName, secondLongName),
      `撞位的第二个会话必须回退 12 位目录，实际行: ${formatRow(cli.root, secondRow)}`,
    );
    assert.notEqual(
      secondRow.path,
      firstRow.path,
      `两个会话不得共用执行目录，实际: ${formatRow(cli.root, firstRow)} / ${formatRow(cli.root, secondRow)}`,
    );
    assert.equal(secondRow.directory, cli.conversationRoot, "工作区键路径不得漂移");
    // 两个目录都真实存在，且都挂在同一个日期目录下（碰撞只影响名字长度，不影响布局）。
    assert.deepEqual(
      await readSessionDirNames(cli.conversationRoot, dateDirName),
      [firstShortName, secondLongName].sort(),
    );
    assert.equal(await pathExists(firstRow.path), true, "8 位目录必须存在");
    assert.equal(await pathExists(secondRow.path), true, "12 位目录必须存在");

    // runtime cwd 与持久化 path 一致：快照的 workspacePath 就是 createRecord 传给 runtime 的
    // workingDirectory，它必须等于本会话自己的 12 位目录（而不是被撞的 8 位目录）。
    const outcome = await cli.subscribeConversation(secondSessionId);
    if (outcome.error) {
      const stored = await cli.listStoredSessions();
      assert.fail(
        `订阅撞位会话失败: ${JSON.stringify(outcome.error)}；CLI 自己读 session 库: ${JSON.stringify(stored)}`,
      );
    }
    assert.ok(outcome.snapshot, `订阅必须给出 initial snapshot（frames=${outcome.frameCount}）`);
    assert.equal(
      outcome.snapshot.workspacePath,
      secondRow.path,
      `快照 workspacePath 必须等于本会话的执行 cwd（= 持久化 path），实际: ${String(
        outcome.snapshot.workspacePath,
      )}`,
    );
    assert.equal(
      cli.readSessionRow(secondSessionId)?.path,
      secondRow.path,
      "订阅不得改写持久化 path",
    );
    assert.equal(
      cli.readSessionRow(firstSessionId)?.path,
      firstRow.path,
      "另一个会话的 path 不得被改写",
    );
  });
});

/**
 * A10/验收15+规则8：日期目录被**普通文件**占住时的冷恢复。
 *
 * 第五轮加的「日期目录可用性」守卫只在纯函数层被断言过（`conversation-session-workspace.test.mjs`
 * 只检查 `resolveConversationSessionWorkspaceForResume` 返回 undefined），而真实调用方还有一层
 * `?? isPersistedConversationExecutionPath(...)` 兜底：它把刚被拒的 `session.path` 又捞了回来，
 * 于是守卫的裁决被丢弃——`createRecord` 的 provided 分支照旧 `mkdir`，报 ENOTDIR，
 * **整个 session/resume 失败**（规格承诺的是「退回 cwd = workspacePath、不抛错」）。
 *
 * 修复后：规则适用 + 行里是本规则的会话目录 ⇒ 显式降级（并把 `path` 写回工作区键路径，因为
 * core 的冷恢复只认库里的 `path`），占位者原样不动。
 */
test("A10/验收15：日期目录是普通文件时冷恢复降级为工作区键路径，不报 ENOTDIR", async () => {
  await withRestartedCliProcess({ label: "a10" }, async ({ cli, sessionId, seedRow, root }) => {
    const sessionDirectory = seedRow.path;
    // 日期段取**会话自己的创建日**（恢复路径也是按 `session.time.created` 算的），
    // 而不是测试进程的「今天」：两者跨零点会差一天，占位者会落到另一个日期目录上。
    const dateDir = join(cli.conversationRoot, localDateDirName(seedRow.time_created));
    assert.equal(
      sessionDirectory,
      join(dateDir, sessionDirName(sessionId)),
      `前置条件：会话目录必须落在会话创建日的日期目录下，实际: ${formatRow(root, seedRow)}`,
    );

    // 删掉会话目录，再把**日期目录**换成一个普通文件（用户/同步工具的破坏形态）。
    await rm(sessionDirectory, { recursive: true, force: true });
    await rm(dateDir, { recursive: true, force: true });
    await writeFile(dateDir, "not a directory\n", "utf8");

    const outcome = await cli.resumeSession(sessionId);
    assert.equal(
      outcome.error,
      undefined,
      `日期目录不可用时必须是降级而不是失败，实际错误: ${JSON.stringify(outcome.error)}`,
    );

    const rowAfter = cli.readSessionRow(sessionId);
    assert.equal(
      rowAfter?.directory,
      cli.conversationRoot,
      `工作区键路径不得漂移，实际行: ${formatRow(root, rowAfter)}`,
    );
    assert.equal(
      rowAfter?.path,
      cli.conversationRoot,
      `降级必须落盘：库里的 path 要写回工作区键路径（core 冷恢复只认它），实际行: ${formatRow(
        root,
        rowAfter,
      )}`,
    );
    // 占位者原样：不删、不修、不跟随。
    assert.equal((await stat(dateDir)).isFile(), true, "用户放在该位置的普通文件不得被改动");
  });
});

/**
 * A11/验收15+规则8：日期目录是指向对话根之外的**符号链接**时的冷恢复。
 *
 * 修复前 `mkdir(recursive)` 会跟随链接，把会话目录建到链接目标（对话根之外），而词法包含判定
 * 仍说「在根内」、回收（lstat 判真目录）与清扫（dirent.isDirectory）都拒绝这种中间链接 ⇒
 * 目录永不被清理。修复后必须降级到工作区键路径，链接目标里一个目录都不许出现。
 */
test("A11/验收15：日期目录是符号链接时冷恢复不跟随链接、不越界建目录", async () => {
  await withRestartedCliProcess({ label: "a11" }, async ({ cli, sessionId, seedRow, root }) => {
    const sessionDirectory = seedRow.path;
    // 同 A10：占位的日期目录取会话自己的创建日。
    const dateDir = join(cli.conversationRoot, localDateDirName(seedRow.time_created));
    const outside = join(root, "outside-" + localDateDirName(seedRow.time_created));
    await mkdir(outside, { recursive: true });

    await rm(sessionDirectory, { recursive: true, force: true });
    await rm(dateDir, { recursive: true, force: true });
    await symlink(outside, dateDir, "dir");

    const outcome = await cli.resumeSession(sessionId);
    assert.equal(
      outcome.error,
      undefined,
      `日期目录不可用时必须是降级而不是失败，实际错误: ${JSON.stringify(outcome.error)}`,
    );

    const rowAfter = cli.readSessionRow(sessionId);
    assert.equal(
      rowAfter?.path,
      cli.conversationRoot,
      `降级必须落盘为工作区键路径，实际行: ${formatRow(root, rowAfter)}`,
    );
    assert.deepEqual(await readdir(outside), [], "不得跟随日期目录链接把会话目录建到对话根之外");
    assert.equal((await lstat(dateDir)).isSymbolicLink(), true, "占位链接不得被改动");
  });
});

/**
 * A12/验收15+规则8（**创建侧**）：日期目录被普通文件占住时的「导入创建复用持久化 cwd」。
 *
 * 与 A10/A11 的区别是入口：那两条走恢复，这条走 `session/create` 且带 `importedHistory` + 同一个
 * sessionId（幂等重试 / 删除后重新导入的真实形态）。创建边界会把行里的 `path` 当 `provided`
 * 直接交给 `ensureConversationSessionWorkspaceDir`——`isConversationSessionDateDirUsable` 只在
 * 「铸造新目录」的分支里跑，复用分支不过这道门。于是：
 * - 普通文件占位 ⇒ `mkdir` 抛 ENOTDIR，整个导入创建确定性失败（规则 8 承诺的是降级）；
 * - 符号链接占位 ⇒ `mkdir` 跟随链接，把会话目录建到对话根之外（A13）。
 * 规则 8 的判据必须在**两条**创建支路上都成立：被拒的复用要退回 `cwd = workspacePath` 并落盘。
 */
test("A12/验收15：日期目录是普通文件时导入创建（带 sessionId 重放）降级，不报 ENOTDIR", async () => {
  await withCliProcess({ label: "a12", injectConversationRoot: true }, async (cli) => {
    const sessionId = await cli.createPersistedSession({ workspacePath: cli.conversationRoot });
    const seedRow = await cli.waitForSessionRow(sessionId);
    const dateDir = join(cli.conversationRoot, localDateDirName(seedRow.time_created));
    assert.equal(
      seedRow.path,
      join(dateDir, sessionDirName(sessionId)),
      `前置条件：会话目录必须落在会话创建日的日期目录下，实际行: ${formatRow(cli.root, seedRow)}`,
    );

    // 破坏日期目录：删掉会话目录，再把日期目录换成一个普通文件。
    await rm(seedRow.path, { recursive: true, force: true });
    await rm(dateDir, { recursive: true, force: true });
    await writeFile(dateDir, "not a directory\n", "utf8");

    const again = await cli.createPersistedSession({
      sessionId,
      workspacePath: cli.conversationRoot,
    });
    assert.equal(again, sessionId);

    const rowAfter = cli.readSessionRow(sessionId);
    assert.equal(
      rowAfter?.directory,
      cli.conversationRoot,
      `工作区键路径不得漂移，实际行: ${formatRow(cli.root, rowAfter)}`,
    );
    assert.equal(
      rowAfter?.path,
      cli.conversationRoot,
      `被拒的复用必须落盘为工作区键路径（core 冷恢复只认它），实际行: ${formatRow(
        cli.root,
        rowAfter,
      )}`,
    );
    assert.equal((await stat(dateDir)).isFile(), true, "用户放在该位置的普通文件不得被改动");
  });
});

/**
 * A13/验收15+规则8（创建侧，符号链接形态）：复用分支不得跟随链接把会话目录建到对话根之外。
 *
 * 这是 A12 的同构用例，但失败形态更隐蔽：`mkdir(recursive)` 会成功，运行期 cwd 落在对话根之外，
 * 而词法包含判定仍说「在根内」、回收（`isRealDirectory`）与清扫（`dirent.isDirectory`）都拒绝这种
 * 中间链接 ⇒ 目录永远不被回收。
 */
test("A13/验收15：日期目录是符号链接时导入创建不跟随链接、不越界建目录", async () => {
  await withCliProcess({ label: "a13", injectConversationRoot: true }, async (cli) => {
    const sessionId = await cli.createPersistedSession({ workspacePath: cli.conversationRoot });
    const seedRow = await cli.waitForSessionRow(sessionId);
    const dateDir = join(cli.conversationRoot, localDateDirName(seedRow.time_created));
    const outside = join(cli.root, "outside-" + localDateDirName(seedRow.time_created));
    await mkdir(outside, { recursive: true });

    await rm(seedRow.path, { recursive: true, force: true });
    await rm(dateDir, { recursive: true, force: true });
    await symlink(outside, dateDir, "dir");

    const again = await cli.createPersistedSession({
      sessionId,
      workspacePath: cli.conversationRoot,
    });
    assert.equal(again, sessionId);

    const rowAfter = cli.readSessionRow(sessionId);
    assert.equal(
      rowAfter?.path,
      cli.conversationRoot,
      `降级必须落盘为工作区键路径，实际行: ${formatRow(cli.root, rowAfter)}`,
    );
    assert.deepEqual(await readdir(outside), [], "不得跟随日期目录链接把会话目录建到对话根之外");
    assert.equal((await lstat(dateDir)).isSymbolicLink(), true, "占位链接不得被改动");
  });
});

/**
 * A14/验收15+规则8：**会话目录自身**（`<根>/<日期>/<id8>`，而不是日期目录）被普通文件占住时的冷恢复。
 *
 * A10/A11 只覆盖了日期目录这一层；复用分支过去也只复检日期目录，于是末段是文件时
 * `ensureConversationSessionWorkspaceDir` 的 `mkdir` 抛 EEXIST，异常一路冒到 `session/resume`——
 * 该会话**每次打开都失败**，且没有任何降级或写回（用户只能手删那个文件）。修复后与 A10 同形：
 * 降级为工作区键路径并把 `path` 写回行，占位者原样不删不修。
 */
test("A14/验收15：会话目录是普通文件时冷恢复降级为工作区键路径，不报 EEXIST", async () => {
  await withRestartedCliProcess({ label: "a14" }, async ({ cli, sessionId, seedRow, root }) => {
    const sessionDirectory = seedRow.path;
    // 前置：末段必须真的落在会话创建日的日期目录下（与 A10 同一条核对）。
    const dateDir = join(cli.conversationRoot, localDateDirName(seedRow.time_created));
    assert.equal(
      sessionDirectory,
      join(dateDir, sessionDirName(sessionId)),
      `前置条件：会话目录必须落在会话创建日的日期目录下，实际: ${formatRow(root, seedRow)}`,
    );

    // 把**末段**换成一个普通文件，日期目录保持健康（这正是 A10/A11 覆盖不到的形态）。
    await rm(sessionDirectory, { recursive: true, force: true });
    await writeFile(sessionDirectory, "not a directory\n", "utf8");

    const outcome = await cli.resumeSession(sessionId);
    assert.equal(
      outcome.error,
      undefined,
      `会话目录被占位时必须是降级而不是失败，实际错误: ${JSON.stringify(outcome.error)}`,
    );

    const rowAfter = cli.readSessionRow(sessionId);
    assert.equal(
      rowAfter?.path,
      cli.conversationRoot,
      `降级必须落盘：库里的 path 要写回工作区键路径（core 冷恢复只认它），实际行: ${formatRow(
        root,
        rowAfter,
      )}`,
    );
    assert.equal(
      (await stat(sessionDirectory)).isFile(),
      true,
      "用户放在该位置的普通文件不得被改动",
    );
  });
});

/**
 * A15/验收15+规则8：会话目录本身是指向对话根之外的**活链接**时的冷恢复。
 *
 * 这一形态最隐蔽：`mkdir(recursive)` **成功**（目标已存在），于是修复前既没有失败也没有落盘降级
 * ——record 的 `executionWorkspacePath` 就是那条词法上「在根内」的链接路径，Agent 实际跑在对话根
 * 之外，回收与清扫都不认它。修复后必须降级：`path` 写回工作区键路径，链接原样。
 */
test("A15/验收15：会话目录是符号链接时冷恢复不跟随链接、写回工作区键路径", async () => {
  await withRestartedCliProcess({ label: "a15" }, async ({ cli, sessionId, seedRow, root }) => {
    const sessionDirectory = seedRow.path;
    const outside = join(root, "outside-leaf-" + localDateDirName(seedRow.time_created));
    await mkdir(outside, { recursive: true });

    await rm(sessionDirectory, { recursive: true, force: true });
    await symlink(outside, sessionDirectory, "dir");

    const outcome = await cli.resumeSession(sessionId);
    assert.equal(
      outcome.error,
      undefined,
      `末段是符号链接时必须是降级而不是跟随链接，实际错误: ${JSON.stringify(outcome.error)}`,
    );

    const rowAfter = cli.readSessionRow(sessionId);
    assert.equal(
      rowAfter?.path,
      cli.conversationRoot,
      `降级必须落盘为工作区键路径（否则会话继续跑在对话根之外），实际行: ${formatRow(
        root,
        rowAfter,
      )}`,
    );
    // 这里**刻意不**断言「链接目标目录仍然为空」：末段是活链接时，修复前的 `mkdir(recursive)`
    // 会**成功**（目标已存在 ⇒ 什么都不建），`readdir(outside)` 在修复前后都是空数组——
    // 那种断言恒真，只会给人「边界已守住」的错觉（A11/A13 的同形状断言有牙，因为链接在
    // **中间**那层，mkdir 会真的在链接目标里造出会话目录）。本场景的判据是上面两条：恢复必须
    // 成功（不是 EEXIST/ENOTDIR），且 `path` 必须写回工作区键路径——core 冷恢复只从库里那一行
    // 取执行 cwd，行被写回即运行目录不再落在链接目标里。
    assert.equal((await lstat(sessionDirectory)).isSymbolicLink(), true, "占位链接不得被改动");
  });
});

test("A9b/边界11：关闭后的持久化路径仍占用 8 位前缀", async () => {
  await withCliProcess({ injectConversationRoot: true, label: "a9b" }, async (cli) => {
    const firstSessionId = `${SESSION_ID_PREFIX}bbbbbbbb-1111-4111-8111-111111111111`;
    const secondSessionId = `${SESSION_ID_PREFIX}bbbbbbbb-2222-4222-8222-222222222222`;
    const createdAt = Date.now();
    const createOnce = async (sessionId) => {
      const { result, error } = await cli.request(SESSION_CREATE_METHOD, {
        workspace: { workspaceKey: cli.conversationRoot, workspacePath: cli.conversationRoot },
        persistence: "immediate",
        sessionId,
        importedHistory: {
          source: "claudeCode",
          title: "deactivated 8-hex-prefix collision e2e",
          createdAt,
          messages: [{ content: "collision history", role: "user", timestamp: createdAt }],
        },
      });
      assert.equal(error, undefined, `session/create returned error: ${JSON.stringify(error)}`);
      assert.equal(result?.messages?.[0]?.info?.sessionId, sessionId);
      return await cli.waitForSessionRow(sessionId);
    };

    const firstRow = await createOnce(firstSessionId);
    const closed = await cli.request(SESSION_CLOSE_METHOD, { sessionId: firstSessionId });
    assert.equal(
      closed.error,
      undefined,
      `session/close returned error: ${JSON.stringify(closed.error)}`,
    );
    assert.equal(closed.result?.closed, true, "first session must leave the active registry");
    assert.equal(
      cli.readSessionRow(firstSessionId)?.path,
      firstRow.path,
      "deactivation must leave its persisted execution path as the collision oracle",
    );

    const secondRow = await createOnce(secondSessionId);
    assert.equal(
      secondRow.path,
      join(cli.conversationRoot, localDateDirName(createdAt), sessionDirName(secondSessionId, 12)),
      `persisted closed session must force the 12-digit name, actual: ${formatRow(cli.root, secondRow)}`,
    );
    assert.notEqual(secondRow.path, firstRow.path, "closed and new sessions must not share a cwd");
  });
});

test("A22/规则45：别名下在册 cwd 及派生目录在存在或缺失时都阻止复用祖先", async () => {
  await withCliProcess({ injectConversationRoot: true, label: "a22" }, async (cli) => {
    const alias = join(cli.root, "conversation-alias");
    await symlink(cli.conversationRoot, alias, "dir");
    let index = 0;
    for (const nested of [false, true]) {
      for (const exists of [false, true]) {
        index += 1;
        const prefix = `aa00000${index}`;
        const targetId = `${SESSION_ID_PREFIX}${prefix}-2222-4222-8222-222222222222`;
        const createdAt = Date.now();
        const date = localDateDirName(createdAt);
        const canonicalLeaf = join(cli.conversationRoot, date, prefix);
        const occupied = join(alias, date, prefix, ...(nested ? ["nested", "child"] : []));
        const ownerId = await cli.createPersistedSession({ workspacePath: cli.conversationRoot });
        const closed = await cli.request(SESSION_CLOSE_METHOD, { sessionId: ownerId });
        assert.equal(closed.error, undefined);
        // 只留下派生会话的认领事实，原父行已不在这个目录；不能依赖父行保留祖先。
        cli.updateSessionPaths(ownerId, { path: occupied, directory: cli.conversationRoot });
        if (exists) await mkdir(occupied, { recursive: true });
        else assert.equal(await pathExists(canonicalLeaf), false);
        const created = await cli.request(SESSION_CREATE_METHOD, {
          workspace: { workspaceKey: cli.conversationRoot, workspacePath: cli.conversationRoot },
          persistence: "immediate",
          sessionId: targetId,
          importedHistory: {
            source: "claudeCode",
            createdAt,
            messages: [{ role: "user", content: "allocation alias fixture", timestamp: createdAt }],
          },
        });
        assert.equal(created.error, undefined, `session/create: ${JSON.stringify(created.error)}`);
        const row = await cli.waitForSessionRow(targetId);
        assert.equal(
          row.path,
          join(cli.conversationRoot, date, sessionDirName(targetId, 12)),
          `nested=${nested}, exists=${exists}: must reserve the occupied ancestor`,
        );
        assert.equal(cli.readSessionRow(ownerId)?.path, occupied, "占用者路径不可改写");
      }
    }
  });
});

test("A16/规则20：草稿目录被清扫后首发重建并保持相对写入 cwd", async () => {
  await withCliProcess({ label: "a16", injectConversationRoot: true }, async (cli) => {
    const draft = await cli.createSession({ workspaceId: cli.conversationRoot });
    assert.equal(draft.ack.status, "accepted", `createSession ACK: ${JSON.stringify(draft.ack)}`);
    const dateDirs = await readDateDirectories(cli.conversationRoot);
    assert.equal(dateDirs.length, 1, `草稿应只有一个日期目录: ${JSON.stringify(dateDirs)}`);
    const executionPath = join(cli.conversationRoot, dateDirs[0], sessionDirName(draft.sessionId));
    assert.equal(await pathExists(executionPath), true, "草稿创建时必须分配独立 cwd");

    // 等价于启动清扫回收尚未持久化的草稿叶目录；首条真实输入必须先复核并重建它。
    await rm(executionPath, { recursive: true, force: true });
    const ack = await cli.command({
      ...createCommandEnvelope("sendText", {
        text: "queue after draft workspace cleanup",
        requestedDelivery: "queue",
        modelSelection: { providerId: "fixture-api", modelId: "fixture-model" },
        modelExecution: { selectionScope: "execution" },
      }),
      sessionId: draft.sessionId,
    });
    assert.equal(ack.status, "accepted", `first send ACK: ${JSON.stringify(ack)}`);

    const row = await cli.waitForSessionRow(draft.sessionId);
    assert.equal(row.path, executionPath, "首发持久化的 cwd 不得漂移到对话根");
    assert.equal(await pathExists(executionPath), true, "首发准入必须重建被清扫的 cwd");
    const snapshot = await cli.readSessionSnapshot(draft.sessionId);
    assert.equal(
      snapshot.error,
      undefined,
      `session/read error: ${JSON.stringify(snapshot.error)}`,
    );
    assert.equal(snapshot.snapshot?.session?.executionWorkspacePath, executionPath);

    const write = spawnSync(
      process.execPath,
      ["-e", "require('node:fs').writeFileSync('relative-admission-probe.txt', 'ok')"],
      { cwd: executionPath, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(write.error, undefined, `relative write process error: ${write.error}`);
    assert.equal(write.status, 0, `relative write failed: ${write.stderr}`);
    assert.equal(await readFile(join(executionPath, "relative-admission-probe.txt"), "utf8"), "ok");
  });
});

test("A17/规则20：坏日期目录降级后拒绝发送且不写入对话根", async () => {
  await withRestartedCliProcess({ label: "a17" }, async ({ cli, sessionId, seedRow }) => {
    const dateDir = join(cli.conversationRoot, localDateDirName(seedRow.time_created));
    await rm(seedRow.path, { recursive: true, force: true });
    await rm(dateDir, { recursive: true, force: true });
    await writeFile(dateDir, "date placeholder must remain\n", "utf8");

    const resumed = await cli.resumeSession(sessionId);
    assert.equal(
      resumed.error,
      undefined,
      `read-only resume fallback failed: ${JSON.stringify(resumed.error)}`,
    );
    assert.equal(
      cli.readSessionRow(sessionId)?.path,
      cli.conversationRoot,
      "existing resume fallback compatibility must keep the root path readable",
    );

    const sentinel = join(cli.conversationRoot, "root-sentinel.txt");
    await writeFile(sentinel, "unchanged\n", "utf8");
    const ack = await cli.command({
      ...createCommandEnvelope("sendText", {
        text: "must not execute from the shared conversation root",
        requestedDelivery: "queue",
        modelSelection: { providerId: "fixture-api", modelId: "fixture-model" },
        modelExecution: { selectionScope: "execution" },
      }),
      sessionId,
    });
    assert.equal(ack.status, "failed", `unsafe send must be rejected: ${JSON.stringify(ack)}`);
    assert.equal(ack.reasonCode, "guard.conversationSessionWorkspaceUnavailable");
    assert.equal(
      await readFile(sentinel, "utf8"),
      "unchanged\n",
      "shared-root sentinel must not change",
    );
    assert.equal((await stat(dateDir)).isFile(), true, "user placeholder must remain untouched");
    assert.equal(cli.readSessionRow(sessionId)?.path, cli.conversationRoot);
  });
});

test("A18/规则20：会话叶目录被占位时拒绝发送且不降级写根", async () => {
  await withCliProcess({ label: "a18", injectConversationRoot: true }, async (cli) => {
    const sessionId = await cli.createPersistedSession({ workspacePath: cli.conversationRoot });
    const row = await cli.waitForSessionRow(sessionId);
    await rm(row.path, { recursive: true, force: true });
    await writeFile(row.path, "leaf placeholder must remain\n", "utf8");
    const sentinel = join(cli.conversationRoot, "root-sentinel.txt");
    await writeFile(sentinel, "unchanged\n", "utf8");

    const ack = await cli.command({
      ...createCommandEnvelope("sendText", {
        text: "must not execute from an occupied session cwd",
        requestedDelivery: "queue",
        modelSelection: { providerId: "fixture-api", modelId: "fixture-model" },
        modelExecution: { selectionScope: "execution" },
      }),
      sessionId,
    });
    assert.equal(ack.status, "failed", `unsafe send must be rejected: ${JSON.stringify(ack)}`);
    assert.equal(ack.reasonCode, "guard.conversationSessionWorkspaceUnavailable");
    assert.equal(await readFile(row.path, "utf8"), "leaf placeholder must remain\n");
    assert.equal(await readFile(sentinel, "utf8"), "unchanged\n");
    assert.equal(
      cli.readSessionRow(sessionId)?.path,
      row.path,
      "failed admission must not rewrite cwd",
    );
  });
});

test(
  "A19/规则20：裸 CLI 从对话根 cwd resume 后准入使用持久化会话执行根",
  { timeout: 45_000 },
  async () => {
    let requestCount = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the fixture request before returning a deterministic auth error.
      }
      requestCount += 1;
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture reached provider boundary" } }));
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

    try {
      await withCliProcess({ label: "a19", injectConversationRoot: true }, async (cli) => {
        const sessionId = await cli.createPersistedSession({ workspacePath: cli.conversationRoot });
        const row = await cli.waitForSessionRow(sessionId);
        assert.notEqual(
          row.path,
          cli.conversationRoot,
          "seed session must have an independent cwd",
        );
        persistSessionModelSelection(cli.sessionDbPath, sessionId);

        const providerConfigPath = join(cli.root, "personal-provider.json");
        const providerConfig = {
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: [
                {
                  providerId: "fixture-api",
                  providerName: "Local fixture",
                  enabled: true,
                  config: {
                    group: "standard-personal",
                    api: {
                      type: "openai-chat-completions",
                      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
                    },
                    access: { type: "api-key", apiKey: "fixture-only" },
                    personalModelIds: ["fixture-model"],
                    modelOrder: ["fixture-model"],
                  },
                },
              ],
            },
            modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
            providerOrder: ["fixture-api"],
            defaultModelSelection: {
              providerId: "fixture-api",
              modelId: "fixture-model",
              options: { reasoningLevel: "disabled" },
            },
          },
        };
        await writeFile(providerConfigPath, JSON.stringify(providerConfig), "utf8");

        const { root, conversationRoot, sessionDbPath } = cli;
        cli.releaseRoot();
        await cli.stop();
        try {
          const outcome = await runBareResumePrompt({
            conversationRoot,
            providerConfigPath,
            root,
            sessionDbPath,
            sessionId,
          });
          assert.equal(
            outcome.timedOut,
            false,
            `bare CLI timed out: ${outcome.stderr.slice(-3000)}`,
          );
          assert.ok(
            requestCount > 0,
            `prompt must pass resume admission before the local provider request; code=${outcome.code} signal=${outcome.signal}\n${outcome.stderr.slice(-3000)}`,
          );
          assert.doesNotMatch(outcome.stderr, /guard\.conversationSessionWorkspaceUnavailable/u);
        } finally {
          await cleanupDirectory(root);
        }
      });
    } finally {
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  },
);

test("A21/规则26：并发旧会话补发及创建混合碰撞保持独立 cwd", async () => {
  for (const mixed of [false, true]) {
    const seed = await startCliProcess({
      label: `a21-seed-${mixed}`,
      injectConversationRoot: false,
    });
    const ids = [
      "sess_bbbbbbbb-1111-4111-8111-111111111111",
      "sess_bbbbbbbb-2222-4222-8222-222222222222",
    ];
    const createdAt = Date.now();
    const create = (cli, sessionId) =>
      cli.request(SESSION_CREATE_METHOD, {
        workspace: { workspaceKey: cli.conversationRoot, workspacePath: cli.conversationRoot },
        sessionId,
        persistence: "immediate",
        importedHistory: {
          source: "claudeCode",
          title: "legacy collision fixture",
          createdAt,
          messages: [{ content: "legacy collision fixture", role: "user", timestamp: createdAt }],
        },
      });
    let root;
    try {
      await seed.waitForStorageReady();
      for (const id of mixed ? ids.slice(0, 1) : ids) {
        assert.equal((await create(seed, id)).error, undefined);
        assert.equal((await seed.waitForSessionRow(id)).path, seed.conversationRoot);
      }
      root = seed.root;
      seed.releaseRoot();
    } finally {
      await seed.stop();
    }
    const cli = await startCliProcess({
      label: `a21-resume-${mixed}`,
      injectConversationRoot: true,
      root,
    });
    try {
      await cli.waitForStorageReady();
      const responses = await Promise.all([
        cli.request(SESSION_RESUME_METHOD, { sessionId: ids[0] }),
        mixed ? create(cli, ids[1]) : cli.request(SESSION_RESUME_METHOD, { sessionId: ids[1] }),
      ]);
      for (const response of responses) assert.equal(response.error, undefined);
      const rows = await Promise.all(ids.map((id) => cli.waitForSessionRow(id)));
      assert.notEqual(rows[0].path, rows[1].path, "补发不能认领另一个会话的执行目录");
      assert.deepEqual(
        rows.map((row) => row.path.split(/[\\/]/u).at(-1).length).sort((a, b) => a - b),
        [8, 12],
      );
      for (let index = 0; index < ids.length; index += 1) {
        const read = await cli.subscribeConversation(ids[index]);
        assert.equal(read.error, undefined);
        assert.equal(read.snapshot.workspacePath, rows[index].path);
      }
    } finally {
      await cli.stop();
    }
  }
});
