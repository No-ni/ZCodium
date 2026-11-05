import { join, extname, dirname } from "node:path";
import { homedir } from "node:os";
import { stat, readFile, readdir, open } from "node:fs/promises";
import { type Plugin } from "vite";
import type { StdioTrafficReadResponse } from "./contract.js";

export const STDIO_TRAFFIC_API_PATH = "/api/dev/stdio-traffic";

export const STDIO_TRAFFIC_LOG_DIR = join(
  process.env.ZCODE_DATA_BASE_DIR?.trim() || process.env.HOME?.trim() || homedir(),
  ".zcodium",
  "v2",
  "dev",
  "stdio-traffic",
);

export const MAX_TAIL_BYTES = 2 * 1024 * 1024;

export const DEFAULT_RECORD_LIMIT = 300;

export interface StdioTrafficFile {
  filePath: string;
  mtimeMs: number;
  workspaceHash: string;
}

export function sendJson(
  response: { setHeader: (name: string, value: string) => void; end: (body: string) => void },
  body: StdioTrafficReadResponse,
) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

export async function fileExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readLatestPointer(workspaceDir: string) {
  const latestPath = join(workspaceDir, "latest.txt");
  if (!(await fileExists(latestPath))) {
    return null;
  }

  const filePath = (await readFile(latestPath, "utf-8")).trim().split(/\r?\n/u)[0] ?? "";
  if (!filePath || extname(filePath) !== ".ndjson" || dirname(filePath) !== workspaceDir) {
    return null;
  }

  return filePath;
}

export async function findWorkspaceLatestFile(logDir: string, workspaceHash: string) {
  const workspaceDir = join(logDir, workspaceHash);
  const latestFilePath = await readLatestPointer(workspaceDir);
  const candidates: StdioTrafficFile[] = [];

  if (latestFilePath && (await fileExists(latestFilePath))) {
    const fileStat = await stat(latestFilePath);
    candidates.push({ filePath: latestFilePath, mtimeMs: fileStat.mtimeMs, workspaceHash });
  }

  if (candidates.length === 0) {
    const entries = await readdir(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ndjson")) {
        continue;
      }
      const filePath = join(workspaceDir, entry.name);
      const fileStat = await stat(filePath);
      candidates.push({ filePath, mtimeMs: fileStat.mtimeMs, workspaceHash });
    }
  }

  return candidates.sort((first, second) => second.mtimeMs - first.mtimeMs)[0] ?? null;
}

export async function findLatestTrafficFile(logDir: string) {
  if (!(await fileExists(logDir))) {
    return null;
  }

  const entries = await readdir(logDir, { withFileTypes: true });
  const candidates: StdioTrafficFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const latestFile = await findWorkspaceLatestFile(logDir, entry.name);
    if (latestFile) {
      candidates.push(latestFile);
    }
  }

  return candidates.sort((first, second) => second.mtimeMs - first.mtimeMs)[0] ?? null;
}

export async function readTailLines(filePath: string, limit: number) {
  const fileStat = await stat(filePath);
  if (fileStat.size === 0) {
    return [];
  }

  const start = Math.max(0, fileStat.size - MAX_TAIL_BYTES);
  const length = fileStat.size - start;
  const buffer = Buffer.alloc(length);
  const file = await open(filePath, "r");
  try {
    await file.read(buffer, 0, length, start);
  } finally {
    await file.close();
  }

  let text = buffer.toString("utf-8");
  if (start > 0) {
    const firstLineBreak = text.indexOf("\n");
    text = firstLineBreak >= 0 ? text.slice(firstLineBreak + 1) : "";
  }

  return text.split(/\r?\n/u).filter(Boolean).slice(-limit);
}

export function parseRecordLines(lines: string[]) {
  return lines.flatMap((line, index) => {
    try {
      return [{ index, record: JSON.parse(line) as unknown }];
    } catch (error) {
      return [
        {
          index,
          record: {
            ts: new Date().toISOString(),
            direction: "agent-stderr",
            bytes: Buffer.byteLength(line),
            raw: line,
            parseError: error instanceof Error ? error.message : String(error),
          },
        },
      ];
    }
  });
}

export function stdioTrafficApiPlugin(): Plugin {
  return {
    name: "zcode-dev-docs-stdio-traffic-api",
    configureServer(server) {
      server.middlewares.use(STDIO_TRAFFIC_API_PATH, async (request, response) => {
        try {
          const requestUrl = new URL(request.url ?? "", "http://localhost");
          const limit = Math.min(
            Number.parseInt(requestUrl.searchParams.get("limit") ?? "", 10) || DEFAULT_RECORD_LIMIT,
            1000,
          );
          const latestFile = await findLatestTrafficFile(STDIO_TRAFFIC_LOG_DIR);
          if (!latestFile) {
            sendJson(response, {
              status: "missing",
              logDir: STDIO_TRAFFIC_LOG_DIR,
              records: [],
            });
            return;
          }

          const lines = await readTailLines(latestFile.filePath, limit);
          sendJson(response, {
            status: lines.length > 0 ? "ready" : "empty",
            logDir: STDIO_TRAFFIC_LOG_DIR,
            workspaceHash: latestFile.workspaceHash,
            filePath: latestFile.filePath,
            updatedAt: new Date(latestFile.mtimeMs).toISOString(),
            records: parseRecordLines(lines),
          });
        } catch (error) {
          sendJson(response, {
            status: "error",
            logDir: STDIO_TRAFFIC_LOG_DIR,
            records: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}
