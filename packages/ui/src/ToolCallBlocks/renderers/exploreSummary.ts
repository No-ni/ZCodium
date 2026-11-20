// 探索统计复用本仓原规则；只派生计数与文案，不持有运行状态。
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";

type IntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const shellCommandMatch = trimmed.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i);
  if (!shellCommandMatch?.[1]) {
    return trimmed;
  }

  const rawInnerCommand = shellCommandMatch[1].trim();
  if (
    (rawInnerCommand.startsWith('"') && rawInnerCommand.endsWith('"')) ||
    (rawInnerCommand.startsWith("'") && rawInnerCommand.endsWith("'"))
  ) {
    return rawInnerCommand.slice(1, -1).trim();
  }

  return rawInnerCommand;
}

function collectCommandStrings(input: unknown): string[] {
  const commandCandidates: string[] = [];

  const collectFromValue = (value: unknown) => {
    if (typeof value === "string") {
      const command = value.trim();
      if (command.length > 0) {
        commandCandidates.push(command);
      }
      return;
    }

    if (!Array.isArray(value)) {
      return;
    }

    if (value.every((item) => typeof item === "string")) {
      const commandParts = value as string[];
      const shellCommandIndex = commandParts.findIndex((part) => part === "-lc");
      if (shellCommandIndex >= 0 && typeof commandParts[shellCommandIndex + 1] === "string") {
        const shellCommand = commandParts[shellCommandIndex + 1]!.trim();
        if (shellCommand.length > 0) {
          commandCandidates.push(shellCommand);
          return;
        }
      }

      const joinedCommand = commandParts.join(" ").trim();
      if (joinedCommand.length > 0) {
        commandCandidates.push(joinedCommand);
      }
      return;
    }

    for (const item of value) {
      if (!isPlainRecord(item)) {
        continue;
      }

      const parsedCommand = item.cmd;
      if (typeof parsedCommand === "string" && parsedCommand.trim().length > 0) {
        commandCandidates.push(parsedCommand.trim());
      }
    }
  };

  collectFromValue(input);

  if (!isPlainRecord(input)) {
    return Array.from(
      new Set(
        commandCandidates.flatMap((candidate) => unwrapShellCommand(candidate).split(/&&|\|\||;/g)),
      ),
    )
      .map((item) => item.trim())
      .filter(Boolean);
  }

  for (const key of ["command", "cmd", "script", "parsed_cmd"] as const) {
    collectFromValue(input[key]);
  }

  return Array.from(
    new Set(
      commandCandidates.flatMap((candidate) => unwrapShellCommand(candidate).split(/&&|\|\||;/g)),
    ),
  )
    .map((item) => item.trim())
    .filter(Boolean);
}

export type ExploreBucket = "search" | "fetch" | "list" | "file";

function getBucketLabel(intl: IntlLike, bucket: ExploreBucket, count: number) {
  switch (bucket) {
    case "fetch":
      return intl.formatMessage({
        id:
          count === 1
            ? "chat.toolCall.explore.bucket.fetch.one"
            : "chat.toolCall.explore.bucket.fetch.other",
      });
    case "search":
      return intl.formatMessage({
        id:
          count === 1
            ? "chat.toolCall.explore.bucket.search.one"
            : "chat.toolCall.explore.bucket.search.other",
      });
    case "list":
      return intl.formatMessage({
        id:
          count === 1
            ? "chat.toolCall.explore.bucket.list.one"
            : "chat.toolCall.explore.bucket.list.other",
      });
    case "file":
      return intl.formatMessage({
        id:
          count === 1
            ? "chat.toolCall.explore.bucket.file.one"
            : "chat.toolCall.explore.bucket.file.other",
      });
    default:
      return intl.formatMessage({ id: "chat.toolCall.explore.bucket.items" });
  }
}

export function classifyExploreToolCall({
  kind,
  title,
  input,
}: {
  kind: string;
  title?: string;
  input: unknown;
}): ExploreBucket {
  if (resolveToolCallIdentity({ kind, title, input }).family === "web-fetch") return "fetch";
  const fingerprint = `${kind} ${title ?? ""}`.toLowerCase();
  const command = collectCommandStrings(input).join(" ; ").toLowerCase();

  if (
    /(\bgrep\b|\bsearch\b|\bfetch\b|\bweb.?search\b|\bweb.?fetch\b)/i.test(fingerprint) ||
    /(^|\s)(rg|grep|ripgrep|git\s+grep)(\s|$)/i.test(command)
  ) {
    return "search";
  }

  if (
    /(\bglob\b|\bfind\b|\blist\b|\btree\b|\bdir\b|\bls\b)/i.test(fingerprint) ||
    /(^|\s)(ls|find|tree|dir)(\s|$)/i.test(command)
  ) {
    return "list";
  }

  return "file";
}

export function formatExploreSummary(intl: IntlLike, counts: Record<ExploreBucket, number>) {
  const summaryParts: string[] = [];

  if (counts.fetch > 0)
    summaryParts.push(`${counts.fetch} ${getBucketLabel(intl, "fetch", counts.fetch)}`);
  if (counts.search > 0) {
    summaryParts.push(`${counts.search} ${getBucketLabel(intl, "search", counts.search)}`);
  }
  if (counts.list > 0) {
    summaryParts.push(`${counts.list} ${getBucketLabel(intl, "list", counts.list)}`);
  }
  if (counts.file > 0) {
    summaryParts.push(`${counts.file} ${getBucketLabel(intl, "file", counts.file)}`);
  }

  return summaryParts.length > 0
    ? summaryParts.join(", ")
    : intl.formatMessage({ id: "chat.toolCall.explore.emptySummary" });
}
