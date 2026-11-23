import type { LogContext, Logger, LoggerFactory } from "@zcode/contracts";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface LogEntry {
  event?: string;
  context?: Record<string, unknown>;
  args?: unknown[];
}

export async function readLogEntries(logDir: string): Promise<LogEntry[]> {
  // 本地日志仅在版本目录写 JSONL；不能把目录当成旧格式日志文件读取。
  const directory = join(logDir, "diagnostics-v1");
  const files = (await readdir(directory, {withFileTypes: true}))
    .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"));
  const entries: LogEntry[] = [];

  for (const file of files) {
    const content = await readFile(join(directory, file.name), "utf8");
    for (const line of content.trim().split("\n")) {
      if (line) entries.push(JSON.parse(line) as LogEntry);
    }
  }

  return entries;
}

export function createRecordingLoggerFactory(): LoggerFactory & {
  events: string[];
  scheduleCalls: number;
  scheduleLogRetentionCleanup(options?: { logger?: Logger }): void;
} {
  const events: string[] = [];
  let scheduleCalls = 0;

  const loggerFor = (context: LogContext = {}): Logger => ({
    child(childContext) {
      return loggerFor({ ...context, ...childContext });
    },
    debug(_message, logContext) {
      recordEvent(events, context, logContext);
    },
    error(_message, _error, logContext) {
      recordEvent(events, context, logContext);
    },
    info(_message, logContext) {
      recordEvent(events, context, logContext);
    },
    warn(_message, logContext) {
      recordEvent(events, context, logContext);
    },
  });

  return {
    createLogger: () => loggerFor(),
    events,
    get scheduleCalls() {
      return scheduleCalls;
    },
    scheduleLogRetentionCleanup() {
      scheduleCalls += 1;
      events.push("scheduleLogRetentionCleanup");
    },
    setLevel: () => {},
    withContext: (context) => loggerFor(context),
  };
}

function recordEvent(events: string[], baseContext: LogContext, context?: LogContext): void {
  const event = context?.event ?? baseContext.event;
  if (typeof event === "string") {
    events.push(event);
  }
}
