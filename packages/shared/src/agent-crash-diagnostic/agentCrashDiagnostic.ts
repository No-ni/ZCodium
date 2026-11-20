import { createHash } from "node:crypto";
import { extractAgentErrorCode, isErrnoCode } from "./errorCodes.js";

export const AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH = 4_000;

/**
 * Chromium / PartitionAlloc 在 Windows 上内存分配失败时用来终止进程的异常码
 * （base 与 partition_alloc 中的 kOomExceptionCode）。Agent runtime 以 ELECTRON_RUN_AS_NODE
 * 运行在同一个 Electron 可执行文件里，系统可提交内存耗尽时以它退出，且不写 stderr。
 */
export const WINDOWS_NATIVE_OUT_OF_MEMORY_EXIT_CODE = 0xe0000008;

export type AgentProcessExitCause = "native_out_of_memory";

/**
 * 只认能确定说明原因的退出码。其他平台没有同等确定的签名：Linux/macOS 上 Chromium 分配失败走
 * IMMEDIATE_CRASH（SIGTRAP/SIGILL，与任意 CHECK 失败相同），内核 OOM killer 与 macOS jetsam
 * 发 SIGKILL（与手动 kill -9 相同），因此不按信号推断内存不足。
 */
export function classifyAgentProcessExitCause(
  exitCode: number | null | undefined,
): AgentProcessExitCause | undefined {
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode)) return undefined;
  // Windows 退出码是 DWORD；Node 报无符号值，个别通道可能给出有符号 int32，统一按 32 位无符号比较。
  return exitCode >>> 0 === WINDOWS_NATIVE_OUT_OF_MEMORY_EXIT_CODE
    ? "native_out_of_memory"
    : undefined;
}

export type AgentDiagnosticClass = "oom" | "sqlite" | "errno" | "generic" | "none";

export interface AgentCrashDiagnostic {
  errorName: string;
  errorCode: string;
  errorMessage: string;
  errorStack: string;
  errorFingerprint: string;
  diagnosticClass: AgentDiagnosticClass;
}

export interface AgentProcessExitDiagnosticInput {
  exitCode: number | null;
  signal: string | null;
  stderrTail?: readonly string[];
  workspacePath: string;
}

export interface AgentProcessSpawnDiagnosticInput {
  errorName?: string;
  errorCode?: string;
  errorMessage: string;
  errorStack?: string;
  workspacePath: string;
}

const AGENT_CRASH_SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;

const AGENT_CRASH_AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

// Cookie 值是 `a=1; b=2` 多段，赋值规则只到第一个 `;`，后面几段会原样上报。带引号的值只替换到
// 闭合引号并保留引号（同一行后面的 `"code":"ECONNRESET"` 还要用来取错误码）；不带引号的替换到行尾。
const AGENT_CRASH_COOKIE_PATTERN =
  /(["']?(?:set-)?cookie["']?\s*[:=]\s*)(?:(["'])(?:\\.|(?!\2)[^\\])*\2|[^\r\n]*)/gi;

const AGENT_CRASH_API_KEY_PATTERN = /\b(sk-)[A-Za-z0-9_-]{16,}\b/gi;

const AGENT_CRASH_UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

const AGENT_CRASH_STACK_LOCATION_PATTERN = /:\d+:\d+/g;

const AGENT_CRASH_POSIX_HOME_PATTERN = /\/(?:Users|home)\/[^/\s"'`()[\]{}<>]+/g;

const AGENT_CRASH_WINDOWS_HOME_PATTERN = /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`()[\]{}<>]+/gi;

const AGENT_CRASH_WINDOWS_ABSOLUTE_PATH_PATTERN =
  /\b[A-Za-z]:[\\/](?:[^\\/\s"'`()[\]{}<>:]+[\\/])*[^\\/\s"'`()[\]{}<>:]+/g;

const AGENT_CRASH_POSIX_ABSOLUTE_PATH_PATTERN =
  /\/(?:[^/\s"'`()[\]{}<>:]+\/)*[^/\s"'`()[\]{}<>:]+/g;

const AGENT_CRASH_KNOWN_PATH_PLACEHOLDER_PATTERN = /<(?:workspace|home)>[^\s"'`()[\]{}<>]*/g;

const AGENT_OOM_LINE_PATTERN = /\b(?:JavaScript heap out of memory|Reached heap limit)\b/i;

/**
 * util.inspect 打印对象时的单个属性行（`server: 'ESA',`、`responseStatus: 429,`）。
 * 它们是对象转储的内容，不是错误摘要；值限定为字面量，因此不会吞掉 `Error: ENOENT: …`。
 */
const AGENT_INSPECTED_PROPERTY_LINE_PATTERN =
  /^["']?[\w$-]+["']?\s*:\s*(?:'[^']*'|"[^"]*"|-?\d[\d.e+-]*|true|false|null|undefined|\*{3}REDACTED\*{3}|<[\w-]+>|\[[\w ]+\])\s*,?$/i;

function truncateAgentCrashDetail(value: string): string {
  return value.length > AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH
    ? value.slice(0, AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH)
    : value;
}

function redactRemainingAbsolutePaths(value: string): string {
  const protectedPaths: string[] = [];
  const protectedValue = value.replace(AGENT_CRASH_KNOWN_PATH_PLACEHOLDER_PATTERN, (match) => {
    const index = protectedPaths.push(match) - 1;
    return `ZCODE_REDACTED_PATH_${index}_TOKEN`;
  });
  const redacted = protectedValue
    .replace(AGENT_CRASH_WINDOWS_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(AGENT_CRASH_POSIX_ABSOLUTE_PATH_PATTERN, "<path>");
  return protectedPaths.reduce(
    (result, protectedPath, index) =>
      result.replace(`ZCODE_REDACTED_PATH_${index}_TOKEN`, protectedPath),
    redacted,
  );
}

/**
 * Agent stderr / 错误文本里的凭据遮盖。services 逐行收集 stderr（也写进生产日志）时和
 * desktop main 上报 ARMS 前都调用这一份：两层各维护一套、顺序不同时，前一层会先破坏后一层的
 * 匹配锚点（services 先做赋值替换会把 `Bearer` 换掉，main 就再也认不出后面的 token）。
 * 对已处理过的文本再跑一遍结果不变，两层串联与只跑一层等价。
 */
export function redactAgentDiagnosticSecrets(value: string): string {
  return (
    value
      // 先遮 Bearer/Basic 凭据，再做赋值替换：反过来时 `Authorization: Bearer <token>` 只有
      // `Bearer` 被当成值替换，token 留在原处，也不再匹配 scheme 规则。
      .replace(AGENT_CRASH_AUTH_SCHEME_PATTERN, "$1 <redacted>")
      .replace(AGENT_CRASH_COOKIE_PATTERN, (_match, prefix: string, quote?: string) =>
        quote ? `${prefix}${quote}<redacted>${quote}` : `${prefix}<redacted>`,
      )
      // 带引号的值保留引号：去掉引号后再跑一遍，cookie 规则会把它当成不带引号的值替换到行尾。
      .replace(AGENT_CRASH_SENSITIVE_ASSIGNMENT_PATTERN, (match: string, prefix: string) => {
        const quote = match.charAt(prefix.length);
        return quote === '"' || quote === "'"
          ? `${prefix}${quote}<redacted>${quote}`
          : `${prefix}<redacted>`;
      })
      // 裸 key 没有赋值前缀，也必须遮盖。
      .replace(AGENT_CRASH_API_KEY_PATTERN, "$1<redacted>")
  );
}

export function sanitizeAgentCrashDetail(value: string, workspacePath: string): string {
  const withoutWorkspace = workspacePath ? value.split(workspacePath).join("<workspace>") : value;
  // 修复原因：Host reporter 不是唯一输入边界，main 在发送 RUM 前必须再遮一遍凭据和裸 key。
  return truncateAgentCrashDetail(
    redactAgentDiagnosticSecrets(
      redactRemainingAbsolutePaths(
        withoutWorkspace
          .replace(AGENT_CRASH_WINDOWS_HOME_PATTERN, "<home>")
          .replace(AGENT_CRASH_POSIX_HOME_PATTERN, "<home>"),
      ),
    ),
  );
}

function normalizeAgentCrashFingerprintSource(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(AGENT_CRASH_UUID_PATTERN, "<uuid>")
    .replace(AGENT_CRASH_STACK_LOCATION_PATTERN, ":<line>:<column>")
    .replace(/\bpid\s*[:=]\s*\d+\b/gi, "pid=<pid>")
    .replace(AGENT_CRASH_WINDOWS_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(AGENT_CRASH_POSIX_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function normalizeAgentDiagnosticSummary(value: string): string {
  return truncateAgentCrashDetail(value.replace(/\\/g, "/").trim());
}

function isAgentDiagnosticNoise(line: string): boolean {
  return (
    /^(?:\[Object\]\s*,?\s*)+$/i.test(line) ||
    /\[Object\]/i.test(line) ||
    /^node:(?:events|internal)\b/i.test(line) ||
    /^at\s+/i.test(line) ||
    /^\d+:\s*0x[0-9a-f]+\b/i.test(line) ||
    /^\[\d+:0x[0-9a-f]+\]/i.test(line) ||
    /^<---.*--->$/.test(line) ||
    /^-+\s*(?:Native stack trace|JS stacktrace)\s*-+$/i.test(line) ||
    /^\(node:\d+\)\s*ExperimentalWarning:/i.test(line) ||
    /^\(Use `.*--trace-warnings.*\)$/i.test(line) ||
    /^(?:throw er;|Emitted ['"]error['"] event on .* instance at:)$/i.test(line) ||
    /^[}\]]\s*,?$/.test(line) ||
    /^(?:\{|\[)$/.test(line) ||
    /^["']?[\w-]+["']?\s*:\s*(?:\{|\[)$/.test(line) ||
    // 根因：长期运行的 Agent 在 stderr 尾部常是几小时前一次 HTTP 失败的对象转储（响应头逐行），
    // 旧逻辑把首个属性行当摘要、把 `server: 'ESA'` 当 errno，崩溃被错归到无关日志。
    AGENT_INSPECTED_PROPERTY_LINE_PATTERN.test(line)
  );
}

function isSqliteDiagnostic(value: string, errorCode: string): boolean {
  return (
    /^SQLITE_/i.test(errorCode) ||
    /\bSQLiteError\b|\bSQLite\s+(?:migration|database|initialization|lock)\b|\bdatabase (?:is locked|disk image is malformed)\b/i.test(
      value,
    )
  );
}

function classifyAgentDiagnostic(
  value: string,
  errorCode: string,
  hasUsefulSummary: boolean,
): AgentDiagnosticClass {
  if (AGENT_OOM_LINE_PATTERN.test(value)) {
    return "oom";
  }
  if (isSqliteDiagnostic(value, errorCode)) {
    return "sqlite";
  }
  if (isErrnoCode(errorCode)) {
    return "errno";
  }
  return hasUsefulSummary ? "generic" : "none";
}

export function createAgentCrashFingerprint(parts: string[]): string {
  return createHash("sha256")
    .update(parts.map(normalizeAgentCrashFingerprintSource).join("|"))
    .digest("hex")
    .slice(0, 16);
}

function formatExitCode(exitCode: number): string {
  return `0x${(exitCode >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

export function parseAgentProcessExitDiagnostic(
  event: AgentProcessExitDiagnosticInput,
): AgentCrashDiagnostic {
  const errorStack = sanitizeAgentCrashDetail(
    event.stderrTail?.join("\n") ?? "",
    event.workspacePath,
  );
  if (classifyAgentProcessExitCause(event.exitCode) === "native_out_of_memory") {
    // 退出码已确定原因；stderr 只是此前的历史输出，保留在 errorStack 里，不参与摘要与指纹，
    // 同一类崩溃因此聚合到同一个指纹。
    const errorMessage = `Native memory allocation failed (exit code ${formatExitCode(event.exitCode!)})`;
    return {
      errorName: "AgentOutOfMemory",
      errorCode: "ERR_OUT_OF_MEMORY",
      errorMessage,
      errorStack,
      diagnosticClass: "oom",
      errorFingerprint: createAgentCrashFingerprint([
        "AgentOutOfMemory",
        "ERR_OUT_OF_MEMORY",
        errorMessage,
        "",
      ]),
    };
  }
  const lines = errorStack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Bug 根因：旧逻辑把 stderr 第一条非空行当摘要，实际数据中的 [Object]、GC 标题和
  // native 地址因此盖过真正的 OOM / SQLite / errno。先排结构噪音，再按诊断确定性选行。
  const usefulLines = lines.filter((line) => !isAgentDiagnosticNoise(line));
  const oomLine = usefulLines.find((line) => AGENT_OOM_LINE_PATTERN.test(line));
  const stackErrorCode = extractAgentErrorCode(errorStack);
  const sqliteLine = usefulLines.find(
    (line) => !/ExperimentalWarning:/i.test(line) && isSqliteDiagnostic(line, stackErrorCode),
  );
  const errnoLine = usefulLines.find((line) => isErrnoCode(extractAgentErrorCode(line)));
  const errorLine =
    oomLine ??
    sqliteLine ??
    errnoLine ??
    usefulLines.find((line) => /^(?:[A-Za-z_$][\w$]*Error|Error):\s*/.test(line)) ??
    usefulLines.find((line) => /\b(?:Exception|fatal|panic|process exited)\b/i.test(line)) ??
    usefulLines[0];
  const errorMatch = errorLine?.match(/^([A-Za-z_$][\w$]*Error|Error):\s*(.*)$/);
  const errorName = oomLine ? "AgentOutOfMemory" : (errorMatch?.[1] ?? "AgentProcessExit");
  const fallbackMessage = `Agent process exited unexpectedly (code=${event.exitCode ?? "null"}, signal=${event.signal ?? "null"})`;
  const errorMessage = normalizeAgentDiagnosticSummary(
    (oomLine ? oomLine.replace(/^FATAL ERROR:\s*/i, "") : errorMatch?.[2]?.trim()) ||
      errorLine ||
      fallbackMessage,
  );
  const errorCode = oomLine
    ? "ERR_OUT_OF_MEMORY"
    : extractAgentErrorCode(`${errorMessage}\n${errorStack}`);
  const diagnosticClass = classifyAgentDiagnostic(
    `${errorMessage}\n${errorStack}`,
    errorCode,
    errorLine != null,
  );
  return {
    errorName,
    errorCode,
    errorMessage,
    errorStack,
    diagnosticClass,
    errorFingerprint: createAgentCrashFingerprint([
      errorName,
      errorCode,
      errorMessage,
      lines.find((line) => line.startsWith("at ")) ?? "",
    ]),
  };
}

export function parseAgentProcessSpawnDiagnostic(
  event: AgentProcessSpawnDiagnosticInput,
): AgentCrashDiagnostic {
  const errorName = event.errorName || "Error";
  const errorCode = event.errorCode ?? "";
  const errorMessage = sanitizeAgentCrashDetail(event.errorMessage, event.workspacePath);
  const errorStack = sanitizeAgentCrashDetail(event.errorStack ?? "", event.workspacePath);
  const diagnosticClass = classifyAgentDiagnostic(
    `${errorMessage}\n${errorStack}`,
    errorCode,
    Boolean(errorMessage),
  );
  return {
    errorName,
    errorCode,
    errorMessage,
    errorStack,
    diagnosticClass,
    errorFingerprint: createAgentCrashFingerprint([
      errorName,
      errorCode,
      errorMessage,
      errorStack.split(/\r?\n/).find((line) => line.trim().startsWith("at ")) ?? "",
    ]),
  };
}
