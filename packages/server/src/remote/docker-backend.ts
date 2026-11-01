import { safeLogArgs } from "@zcode/shared";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { DockerConnectOptions } from "@zcode/shared";
import type {
  IRemoteBackend,
  RemoteEnvironment,
  RemoteUploadOptions,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import { createCloseEventController } from "@zcode/server/remote/closeEvent.js";
import {
  isDockerAvailable,
  listDockerContainers,
  resolveDockerCommand,
  type DockerContainerInfo,
} from "@zcode/server/remote/docker-detect.js";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@zcode/server/remote/detectEnv.js";

interface ResolvedDockerInfo {
  containerName: string;
  homeDir: string;
}

const DOCKER_EXEC_MAX_BUFFER = 8 * 1024 * 1024;
const DOCKER_UPLOAD_MAX_STDERR_LENGTH = 2_048;
// disposeAndWait 预算与 IRemoteBackend 契约及 WSL backend 同口径：grace 300ms + kill 250ms。
const DOCKER_DISPOSE_GRACE_TIMEOUT_MS = 300;
const DOCKER_DISPOSE_KILL_WAIT_TIMEOUT_MS = 250;

/** 本 backend 自己 spawn 的 exec 子进程所有权条目；closed 在 exit/close/可摘除 error 时收敛。 */
interface OwnedExecChild {
  child: ChildProcess;
  closed: Promise<void>;
  resolveClosed(): void;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function normalizeDockerOutput(raw: string): string {
  return raw.replace(/\r/g, "");
}

function buildDockerExecArgs(containerName: string, commandArgs: string[]): string[] {
  return ["exec", "-i", containerName, ...commandArgs];
}

export class DockerBackend implements IRemoteBackend {
  private readonly dockerCommand = resolveDockerCommand();
  private readonly options: DockerConnectOptions;
  private resolvedInfoPromise: Promise<ResolvedDockerInfo> | null = null;
  // exec() 产物（含 upload 的 cat 管道与 connectRemote 的常驻远端 server）的所有权登记表；
  // 一次性 execFile 命令自行退出，不纳入。详见 docs/specs/docker-backend-process-lifecycle.md。
  private readonly ownedExecChildren = new Set<OwnedExecChild>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: DockerConnectOptions) {
    this.options = options;
  }

  async detect(): Promise<RemoteEnvironment> {
    await this.ensureAvailable();
    const reportedPlatform = normalizeRemotePlatform(
      normalizeDockerOutput(await this.execSimple("uname -s")),
    );
    const arch = normalizeRemoteArch(normalizeDockerOutput(await this.execSimple("uname -m")));
    const kernelOstype = await this.readKernelOstype();
    const platform = resolveRemotePlatform(reportedPlatform, kernelOstype);

    if (platform !== reportedPlatform) {
      // 测试容器里可能通过 wrapper 伪造了 uname 输出，
      // 这里只在发生回退时打一条低频日志，便于排查“为何最终按 Linux 选包”。
      console.warn(
        ...safeLogArgs([
          `[docker] detect: uname reported ${reportedPlatform}, but kernel ostype is ${kernelOstype}; fallback to ${platform}`,
        ]),
      );
    }

    return {
      platform,
      arch,
    };
  }

  async upload(
    localPath: string,
    remotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = this.resolveLinuxPath(remotePath, resolvedInfo.homeDir);
    const parentDir = this.dirname(resolvedRemotePath);

    // 上传流不会帮我们创建父目录。
    // 如果直接写入 `~/.zcodium/server/...` 这类首次连接路径，上传会因为目录不存在而失败。
    // 先显式 `mkdir -p`，再由容器当前用户写入目标文件，和 SSH/WSL 保持一致。
    await this.execSimple(`mkdir -p ${quotePosixShellArg(parentDir)}`);

    // `docker cp` 复制到容器后的文件可能保留宿主 UID/GID，
    // 非 root 容器用户随后无法 chmod。统一由容器当前用户通过 stdin 写入，
    // 保证文件 owner 与后续部署命令的执行用户一致。
    await this.uploadViaExec(localPath, resolvedRemotePath, options ?? {});
  }

  private async uploadViaExec(
    localPath: string,
    resolvedRemotePath: string,
    options: RemoteUploadOptions,
  ): Promise<void> {
    const totalBytes = await stat(localPath).then((value) => value.size);
    if (options.signal?.aborted) {
      const error = new Error("Remote upload canceled");
      error.name = "AbortError";
      throw error;
    }
    const stream = await this.exec(`cat > ${quotePosixShellArg(resolvedRemotePath)}`);
    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const stdin = stream.stdin;
      let stderrText = "";
      let uploadedBytes = 0;
      let settled = false;
      const onStderr = (chunk: Buffer | string) => {
        stderrText = `${stderrText}${chunk.toString()}`.slice(-DOCKER_UPLOAD_MAX_STDERR_LENGTH);
      };
      stream.stderr.on("data", onStderr);
      const removeStderrListener = () => {
        stream.stderr.removeListener("data", onStderr);
      };
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        removeStderrListener();
        readStream.destroy();
        const destroyable = stdin as NodeJS.WritableStream & {
          destroy?: (reason?: Error) => void;
        };
        destroyable.destroy?.(error);
        reject(error);
      };
      const abort = () => {
        const error = new Error("Remote upload canceled");
        error.name = "AbortError";
        finishError(error);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      readStream.on("data", (chunk: Buffer) => {
        uploadedBytes += chunk.length;
        options.onProgress?.({ uploadedBytes, totalBytes });
      });
      readStream.on("error", finishError);
      stdin.on("error", finishError);
      stream.onClose((code) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        removeStderrListener();
        if (code !== 0) {
          const stderrSummary = normalizeDockerOutput(stderrText).trim();
          reject(
            new Error(
              stderrSummary
                ? `Docker upload failed with exit code ${code}: ${stderrSummary}`
                : `Docker upload failed with exit code ${code}`,
            ),
          );
          return;
        }
        options.onProgress?.({ uploadedBytes: totalBytes, totalBytes });
        resolve();
      });
      readStream.pipe(stdin);
    });
  }

  async exec(command: string): Promise<StdioStream> {
    // 已释放的 backend 不能启动新命令：断连/退出后迟到的 exec 必须拒绝，不能留下无人回收的进程。
    this.assertNotDisposed();
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    // dispose 可能在 await 期间到达；此刻再 spawn 会绕过关闭期，创建第二个无人回收的常驻进程。
    this.assertNotDisposed();

    return new Promise((resolve, reject) => {
      const child = spawn(
        this.dockerCommand,
        buildDockerExecArgs(resolvedInfo.containerName, ["sh", "-lc", command]),
        {
          stdio: "pipe",
          windowsHide: true,
        },
      );
      // 每个 exec 产物都登记为本 backend 的所有物，回收只走 disposeAndWait。
      this.trackOwnedExecChild(child);

      child.once("error", reject);
      child.once("spawn", () => {
        const stdin = child.stdin;
        const stdout = child.stdout;
        const stderr = child.stderr;
        if (!stdin || !stdout || !stderr) {
          reject(new Error("Docker exec stdio is not available"));
          return;
        }

        const onClose = createCloseEventController();
        let fired = false;
        const fireOnce = (code: number) => {
          if (fired) {
            return;
          }
          fired = true;
          onClose.fire(code);
        };

        child.on("exit", (code) => {
          fireOnce(code ?? 0);
        });
        child.on("close", (code) => {
          fireOnce(code ?? 0);
        });

        resolve({
          stdin,
          stdout,
          stderr,
          onClose: onClose.event,
        });
      });
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      const resolvedInfo = await this.resolveInfo();
      const resolvedRemotePath = this.resolveLinuxPath(remotePath, resolvedInfo.homeDir);
      await this.execSimple(`test -f ${quotePosixShellArg(resolvedRemotePath)} && printf OK`);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(remotePath: string): Promise<string> {
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = this.resolveLinuxPath(remotePath, resolvedInfo.homeDir);
    return normalizeDockerOutput(
      await this.execSimple(`cat ${quotePosixShellArg(resolvedRemotePath)}`),
    );
  }

  dispose(): void {
    // 修复原因：dispose 过去按「命令都是一次性子进程」做成空实现，但 exec() 会 spawn 常驻
    // docker exec 子进程（connectRemote 的远端 server、upload 的 cat 管道），断开/退出后
    // 无人回收，每次远程会话结束泄漏一个宿主进程。dispose 同步标记 disposed，
    // 回收细节交给 disposeAndWait 的同一 in-flight promise，重复调用幂等。
    this.disposed = true;
    void this.disposeAndWait();
  }

  /**
   * 结束自身 exec 子进程的 stdin，宽限未退后 kill，并等待 close/exit 收敛。
   * 只处理本 backend 自己创建的 child：不执行 docker stop/kill，不触碰共享容器内的其他进程。
   * 预算沿用 IRemoteBackend 契约默认值（grace 300ms + kill 250ms），调用方可覆盖。
   */
  disposeAndWait(options?: { graceTimeoutMs?: number; killWaitTimeoutMs?: number }): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const graceTimeoutMs = Math.max(options?.graceTimeoutMs ?? DOCKER_DISPOSE_GRACE_TIMEOUT_MS, 0);
    const killWaitTimeoutMs = Math.max(
      options?.killWaitTimeoutMs ?? DOCKER_DISPOSE_KILL_WAIT_TIMEOUT_MS,
      0,
    );
    const children = [...this.ownedExecChildren];
    // 修复原因：disposePromise 过去在同步 endOwnedChildInput 之后才赋值，stdin.end()
    // 可能同步触发回调重入 disposeAndWait，重入方看到未发布的 promise 会再走一遍完整
    // 流程（两个 in-flight promise、重复 kill）。这里先在任意 child side effect 之前
    // 发布同一个 in-flight promise，重入调用直接复用；disposed 仍保持同步标记，
    // stdin.end 仍保持同步调用，不引入额外 timer/microtask。
    let settle!: () => void;
    let fail!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.disposePromise = completion;
    // 先结束 stdin 给命令正常收尾的机会；能否退出取决于程序自身，不假设 EOF 一定导致退出，
    // 宽限未退仍会 kill。
    for (const entry of children) this.endOwnedChildInput(entry.child);
    void Promise.all(
      children.map(async (entry) => {
        if (await this.waitForOwnedExecChildClose(entry.closed, graceTimeoutMs)) return;
        // 宽限未退：只 kill 本 backend 自己创建的 child；失败时保留所有权语义，
        // 由后续 close/exit 摘除，不扩大为容器级操作。
        if (this.ownedExecChildren.has(entry)) {
          try {
            entry.child.kill();
          } catch {
            // kill 失败（进程已僵死等）时等待 close/exit 最终摘除。
          }
        }
        await this.waitForOwnedExecChildClose(entry.closed, killWaitTimeoutMs);
      }),
      // 修复原因：等待内部的未知异常（如计时器故障）必须原样向调用方传播；
      // 旧的 settle/settle 会把 reject 吞改为 fulfill，掩盖内部故障。已知的
      // stdin.end()/kill 故障已在各自 try/catch 内按 best-effort 消化，不会到达这里。
    ).then(settle, fail);
    return completion;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Docker backend 已释放，无法执行命令");
    }
  }

  private trackOwnedExecChild(child: ChildProcess): void {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const entry: OwnedExecChild = { child, closed, resolveClosed };
    const finish = () => {
      if (this.ownedExecChildren.delete(entry)) entry.resolveClosed();
    };
    this.ownedExecChildren.add(entry);
    child.once("error", () => {
      // ChildProcess 的 error 事件不等于进程已退出（kill 失败/IPC 失败都会触发）：
      // 仅 spawn 失败（尚无 pid）可立即摘除；alive error 保留所有权，
      // 让 disposeAndWait 的宽限 + kill 路径继续 best-effort 收口。
      if (child.pid == null) finish();
    });
    child.once("exit", finish);
    child.once("close", finish);
  }

  private endOwnedChildInput(child: ChildProcess): void {
    if (!child.stdin || child.stdin.writableEnded) return;
    try {
      child.stdin.end();
    } catch {
      // stdin 已异常关闭时继续进入 kill fallback。
    }
  }

  private waitForOwnedExecChildClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
    // 修复原因：timeoutMs<=0 过去返回 closed.then，未终结 child 会无限等待，违反有界预算。
    // <=0 的语义是「本次不等待」：立即按未收敛返回，让调用方进入 kill/收口路径；
    // 所有权不因此丢失，仍由 exit/close/可摘除 error 的终态摘除。
    if (timeoutMs <= 0) return Promise.resolve(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return Promise.race([
      closed.then(
        () => true,
        () => true,
      ),
      timedOut,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private async ensureAvailable(): Promise<void> {
    const available = await isDockerAvailable();
    if (!available) {
      throw new Error("当前系统未检测到可用的 Docker 环境");
    }
  }

  private async resolveInfo(): Promise<ResolvedDockerInfo> {
    if (this.resolvedInfoPromise) {
      return this.resolvedInfoPromise;
    }

    this.resolvedInfoPromise = (async () => {
      const container = await this.resolveContainer();
      const homeDir = normalizeDockerOutput(
        await this.execDirect(["sh", "-lc", "printf %s ~"]),
      ).trim();

      return {
        containerName: container.name,
        homeDir,
      };
    })();

    return this.resolvedInfoPromise;
  }

  private async resolveContainer(): Promise<DockerContainerInfo> {
    const containers = await listDockerContainers({ all: true });
    const matched = containers.find(
      (container) =>
        container.name === this.options.container ||
        container.id === this.options.container ||
        container.id.startsWith(this.options.container),
    );

    if (!matched) {
      throw new Error(`未找到名为 ${this.options.container} 的 Docker 容器`);
    }

    if (matched.state.toLowerCase() !== "running") {
      throw new Error(
        `Docker 容器 ${matched.name} 当前未运行（state=${matched.state || "unknown"}）`,
      );
    }

    return matched;
  }

  private resolveLinuxPath(remotePath: string, homeDir: string): string {
    if (remotePath === "~") {
      return homeDir;
    }

    if (remotePath.startsWith("~/")) {
      return `${homeDir.replace(/\/$/, "")}/${remotePath.slice(2)}`;
    }

    return remotePath;
  }

  private dirname(remotePath: string): string {
    const normalized = remotePath.replace(/\/+/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash <= 0) {
      return "/";
    }

    return normalized.slice(0, lastSlash);
  }

  private async execSimple(command: string): Promise<string> {
    return this.execDirect(["sh", "-lc", command]);
  }

  private async readKernelOstype(): Promise<string> {
    try {
      return normalizeDockerOutput(
        await this.execSimple(
          "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; fi",
        ),
      ).trim();
    } catch {
      return "";
    }
  }

  private async execDirect(commandArgs: string[]): Promise<string> {
    const container = await this.resolveContainer();
    return new Promise((resolve, reject) => {
      execFile(
        this.dockerCommand,
        buildDockerExecArgs(container.name, commandArgs),
        {
          encoding: "utf8",
          maxBuffer: DOCKER_EXEC_MAX_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(normalizeDockerOutput(stderr).trim() || error.message));
            return;
          }

          resolve(normalizeDockerOutput(stdout));
        },
      );
    });
  }
}
