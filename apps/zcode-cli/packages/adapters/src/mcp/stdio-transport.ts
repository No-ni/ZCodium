import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import type { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import {
  attachProcessToWindowsJobObject,
  type WindowsJobObjectController,
} from "./windows-job-object.js";

type SdkStdioDispose = (this: StdioClientTransport) => Promise<void>;

const sdkDispose = Object.getOwnPropertyDescriptor(StdioClientTransport.prototype, "_dispose")
  ?.value as SdkStdioDispose | undefined;

interface StdioProcessExitInfo {
  exitCode: number | null;
  exitedAt: number;
  signal: NodeJS.Signals | null;
  startedAt: number;
}

interface ProcessTreeStdioClientTransportOptions {
  windowsJobObjectFactory?: (pid: number) => Promise<WindowsJobObjectController | undefined>;
}

/**
 * SDK 2.0 的探测 sibling 与正式连接共用同一启动、进程树和 pipe 回收入口。
 * 原型必须直接拥有 `_dispose`，SDK 才能按相同参数克隆安全的探测 transport。
 */
export class ProcessTreeStdioClientTransport extends StdioClientTransport {
  private childProcess?: ChildProcess;
  private childClosed?: Promise<void>;
  private lastProcessExit?: StdioProcessExitInfo;
  private readonly windowsJobObjectFactory: (
    pid: number,
  ) => Promise<WindowsJobObjectController | undefined>;
  private windowsJobObject?: WindowsJobObjectController;
  private closed = false;
  private starting?: Promise<void>;
  private closing?: Promise<void>;

  constructor(server: StdioServerParameters, options: ProcessTreeStdioClientTransportOptions = {}) {
    super(server);
    this.windowsJobObjectFactory =
      options.windowsJobObjectFactory ?? attachProcessToWindowsJobObject;
  }

  async terminateWindowsJobObject(): Promise<void> {
    const windowsJobObject = this.windowsJobObject;
    this.windowsJobObject = undefined;
    if (!windowsJobObject) return;
    try {
      windowsJobObject.terminate();
    } catch {
      // 继续执行 close 与 taskkill 回退。
    } finally {
      try {
        windowsJobObject.close();
      } catch {
        // 句柄关闭失败不能阻断 SDK pipe 清理。
      }
    }
  }

  override start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("MCP stdio transport is closed"));
    if (this.starting) return Promise.reject(new Error("MCP stdio transport already started"));
    this.starting = this.startProcess();
    return this.starting;
  }

  private async startProcess(): Promise<void> {
    const startedAt = Date.now();
    const spawned = super.start();
    // SDK close 会先清掉 _process；必须在 spawn 的 await 前捕获 child 与真实 close 边界。
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (child) {
      this.childProcess = child;
      this.childClosed = new Promise((resolve) => child.once("close", () => resolve()));
      const recordExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        this.lastProcessExit ??= {
          exitCode,
          exitedAt: Date.now(),
          signal,
          startedAt,
        };
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        recordExit(child.exitCode, child.signalCode);
      } else {
        child.once("exit", recordExit);
      }
    }
    await spawned;
    if (
      child?.pid != null &&
      child.exitCode === null &&
      child.signalCode === null &&
      process.platform === "win32"
    ) {
      try {
        this.windowsJobObject = await this.windowsJobObjectFactory(child.pid);
      } catch {
        // 原生托管不可用时保留 taskkill 回退，不能让 MCP 建连因可选能力失败。
        this.windowsJobObject = undefined;
      }
    }
    if (this.closed) throw new Error("MCP stdio transport is closed");
  }

  override close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      // 启动途中 close 曾先返回，迟到 Job Object 与 SDK continuation 随后又占住 cwd。
      await this.starting?.catch(() => undefined);
      const pid = this.childProcess?.pid;
      await this.terminateWindowsJobObject();
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
        try {
          await terminateMcpStdioProcessTree(pid);
        } catch {
          // 保留 SDK 原有信号升级回退，并继续释放 pipe。
        }
      }
      if (sdkDispose) await sdkDispose.call(this);
      else await super.close();
      await this.childClosed;
      const stderr = this.stderr;
      if (stderr instanceof Readable) stderr.destroy();
    });
    return this.closing;
  }

  get processExit(): StdioProcessExitInfo | undefined {
    return this.lastProcessExit;
  }

  get processAlive(): boolean {
    return Boolean(
      this.childProcess &&
      this.childProcess.exitCode === null &&
      this.childProcess.signalCode === null,
    );
  }
}

Object.defineProperty(ProcessTreeStdioClientTransport.prototype, "_dispose", {
  configurable: true,
  value(this: ProcessTreeStdioClientTransport): Promise<void> {
    return this.close();
  },
});
