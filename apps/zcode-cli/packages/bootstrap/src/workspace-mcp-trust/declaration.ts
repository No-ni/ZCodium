import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { McpServerConfig } from "@zcode/contracts";
import { sanitizeHookDisplayText } from "@zcode/core";
import { normalizeMcpStdioCommand } from "@zcode/shared";

export function executionConfig(config: McpServerConfig, workingDirectory: string): unknown {
  const { enabled: _enabled, source: _source, ...execution } = config;
  return config.type === "stdio"
    ? {
        ...execution,
        ...normalizeMcpStdioCommand(config.command, config.args),
        env: config.env ?? {},
        cwd: config.cwd
          ? isAbsolute(config.cwd)
            ? config.cwd
            : resolve(workingDirectory, config.cwd)
          : workingDirectory,
      }
    : { ...execution, headers: config.headers ?? {} };
}
export function hash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          );
        }
        return item;
      }),
    )
    .digest("hex");
}
export function displayConfig(config: McpServerConfig, workingDirectory: string): string {
  if (config.type === "stdio")
    return sanitizeHookDisplayText(
      JSON.stringify(
        {
          command: sanitizeHookDisplayText([config.command, ...(config.args ?? [])].join(" ")),
          cwd: config.cwd ?? workingDirectory,
          env: Object.keys(config.env ?? {}),
        },
        null,
        2,
      ),
    );
  const url = new URL(config.url);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return JSON.stringify(
    {
      type: config.type,
      url: url.toString(),
      headers: Object.keys(config.headers ?? {}),
      oauth: config.oauth?.type,
    },
    null,
    2,
  );
}
export async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}
