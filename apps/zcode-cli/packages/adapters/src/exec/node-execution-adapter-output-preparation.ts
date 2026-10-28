import { mkdtemp } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExecutionRequest, ExecutionResult, ExecutionRunOptions } from "@zcode/contracts";
import { BashFileOutput } from "./bash-file-output.js";
import type { PreparedBashOutput } from "./execution-adapter-types.js";
import { isBashMergedOutputRequest, resolveDefaultOutputRootDir } from "./execution-utils.js";
import { NodeExecutionAdapterProcess } from "./node-execution-adapter-process.js";
import { resolveLegacyExecutionOutputEncoding } from "./outputEncoding.js";

const BASH_TEMP_DIRECTORY_PREFIX = "zcodium-bash-";
const BASH_TEMP_UNAVAILABLE_CODES = new Set([
  "EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR", "ENOSPC", "EDQUOT",
]);

export class NodeExecutionAdapterOutputPreparation extends NodeExecutionAdapterProcess {
  private bashTempRoot?: Promise<string>;

  protected usesBashTempOutput(request: ExecutionRequest): boolean {
    return this.options.bashOutputTempDir !== undefined && isBashMergedOutputRequest(request);
  }

  private getBashTempRoot(): Promise<string> {
    if (!this.bashTempRoot) {
      const pending = mkdtemp(join(this.options.bashOutputTempDir!, BASH_TEMP_DIRECTORY_PREFIX));
      this.bashTempRoot = pending;
      void pending.catch(() => {
        if (this.bashTempRoot === pending) this.bashTempRoot = undefined;
      });
    }
    return this.bashTempRoot;
  }

  protected async prepareBashOutput(
    request: ExecutionRequest,
    options: ExecutionRunOptions,
  ): Promise<{ prepared: PreparedBashOutput } | { result: ExecutionResult }> {
    const startedAt = new Date();
    let stopped = false;
    const executionId = this.registerActiveExecution(() => { stopped = true; });
    const releasePreparation = () => this.completeActiveExecution(executionId);
    const isStopped = () => stopped || this.closePromise !== undefined || options.signal?.aborted;
    let file: BashFileOutput | undefined;
    const cancelled = async () => {
      await file?.discard();
      releasePreparation();
      return { result: this.createStoppedResult(startedAt, "cancelled", "Execution cancelled before spawn") };
    };
    try {
      if (isStopped()) return await cancelled();
      const legacyOutputEncoding = resolveLegacyExecutionOutputEncoding({
        platform: this.platform, processEnv: this.processEnv,
      });
      const knownPath = this.outputPathForRequest(request, "stdout")!;
      const fallbackPath = join(
        this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv),
        basename(dirname(knownPath)), basename(knownPath),
      );
      try {
        const root = await this.getBashTempRoot();
        if (isStopped()) return await cancelled();
        file = new BashFileOutput(join(root, basename(dirname(fallbackPath)), basename(fallbackPath)),
          this.platform, legacyOutputEncoding);
        await file.prepare();
      } catch (error) {
        if (isStopped()) return await cancelled();
        if (!BASH_TEMP_UNAVAILABLE_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await file?.discard();
        // 数据根搜索可能再次读入正在写入的 Bash 输出；仅临时文件系统不可用时复用旧路径。
        file = new BashFileOutput(fallbackPath, this.platform, legacyOutputEncoding);
        await file.prepare();
      }
      if (isStopped()) return await cancelled();
      // 后台记录必须发布实际路径，不能等 spawn 后再降级或重开输出文件。
      this.outputPathsByRequest.set(request, { outputPath: file.path, stdoutPersistedOutputPath: file.path });
      return { prepared: { file, legacyOutputEncoding, releasePreparation } };
    } catch (error) {
      await file?.discard();
      releasePreparation();
      if (isStopped()) return await cancelled();
      return { result: this.createStoppedResult(startedAt, "spawn_error", this.toFailure("spawn_error", error).message) };
    }
  }
}
