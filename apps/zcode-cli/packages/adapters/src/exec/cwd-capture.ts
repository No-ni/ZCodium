import { mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitBashPathToWindowsPath,
  type ExecutionCommand,
  type ExecutionRequest,
  type ExecutionShellDialect,
  windowsPathToGitBashPath,
} from "@zcode/contracts";

export interface CwdCapturePlan {
  command: ExecutionCommand;
  cwdFilePath?: string;
  cleanup?: () => Promise<void>;
}

export async function createCwdCapturePlan(
  request: ExecutionRequest,
  options: {
    dialect: ExecutionShellDialect;
    platform: NodeJS.Platform;
  },
): Promise<CwdCapturePlan> {
  if (request.captureCwdAfterSuccess !== true || request.command.mode !== "shell") {
    return { command: request.command };
  }

  const cwdCaptureDir = tmpdir();
  await mkdir(cwdCaptureDir, { recursive: true });
  const cwdFilePath = join(cwdCaptureDir, `zcode-${crypto.randomUUID()}-cwd`);
  const commandFilePath = options.dialect === "cmd" ? `${cwdFilePath}.cmd` : undefined;

  // 每次 Bash 仍启动新 shell；成功后只把最终 pwd -P 写回主进程，不能持久化 env/alias/function。
  // 默认 shell、hooks、background command 不走这个分支，避免改变其它执行面。
  const wrappedCommand =
    options.dialect === "cmd"
      ? createWindowsCmdCwdCaptureCommand(request.command.command, cwdFilePath)
      : createPosixCwdCaptureCommand(
          request.command.command,
          options.dialect === "git-bash" ? windowsPathToGitBashPath(cwdFilePath) : cwdFilePath,
          options.dialect,
        );

  if (commandFilePath) {
    // cmd /c 的多行字符串只执行首行；batch 逐行读取 ERRORLEVEL，保留退出码和原命令语义。
    const file = await open(commandFilePath, "wx");
    try {
      try {
        await file.writeFile(`@echo off\r\n${wrappedCommand}\r\n`);
      } finally {
        await file.close();
      }
    } catch (error) {
      await unlink(commandFilePath).catch(() => {});
      throw error;
    }
  }

  return {
    command: {
      ...request.command,
      command: commandFilePath ? cmdQuote(commandFilePath) : wrappedCommand,
    },
    cwdFilePath,
    // 只有现有 execution flight 清理这些文件；正常、失败和准备中取消共用同一 finally。
    cleanup: async () => {
      await Promise.allSettled(
        [cwdFilePath, ...(commandFilePath ? [commandFilePath] : [])].map((path) => unlink(path)),
      );
    },
  };
}

function createPosixCwdCaptureCommand(
  command: string,
  cwdFilePath: string,
  dialect: ExecutionShellDialect,
): string {
  // MSYS 会把自定义 TEMP 映射成 /tmp；Git Bash 必须直接返回物理 Windows 路径，不能猜 mount。
  const pwd = dialect === "git-bash" ? "pwd -P -W" : "pwd -P";
  return [
    command,
    "__zcode_status=$?",
    `if [ "$__zcode_status" -eq 0 ]; then ${pwd} > ${shellQuote(cwdFilePath)}; fi`,
    'exit "$__zcode_status"',
  ].join("\n");
}

function createWindowsCmdCwdCaptureCommand(command: string, cwdFilePath: string): string {
  return [
    command,
    'set "__zcode_status=%ERRORLEVEL%"',
    `if "%__zcode_status%"=="0" cd > ${cmdQuote(cwdFilePath)}`,
    "exit /b %__zcode_status%",
  ].join("\r\n");
}

export async function readCapturedCwd(
  cwdFilePath: string | undefined,
  options: { dialect: ExecutionShellDialect },
): Promise<string | undefined> {
  if (!cwdFilePath) return undefined;
  try {
    const value = (await readFile(cwdFilePath, "utf8")).replace(/\r?\n$/u, "");
    if (!value) return undefined;
    const hostValue = normalizeCapturedCwdForHost(value, options.dialect);
    const stats = await stat(hostValue);
    if (!stats.isDirectory()) return undefined;
    return await realpath(hostValue);
  } catch {
    return undefined;
  }
}

export function normalizeCapturedCwdForHost(
  value: string,
  dialect: ExecutionShellDialect,
): string {
  return dialect === "git-bash" ? gitBashPathToWindowsPath(value) : value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cmdQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
