import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type DataSyncItemDependencies } from "@zcode/shared";
import { migrateUserSubagentMarkdown } from "@zcode/shared/node";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { parseSubagentMarkdown } from "#src/subagents/subagentMarkdown.js";
import { resolveUserSubagentRoot } from "#src/subagents/subagentStorage.js";
import { collectAgentMarkdownPaths } from "#src/subagents/subagentsService.js";

const logger = createServiceLogger("subagent-data-sync");

interface ResolvedUserSubagent {
  key: string;
  name: string;
  description: string;
  filePath: string;
  dependencies?: DataSyncItemDependencies;
  /** 迁移之后的文件字节。 */
  content: Buffer;
}

function hashContent(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function toSubagentKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 依赖只认运行时支持的字符串名称（见 CLI `parseAgentMcpServers`）：MCP 的对象形式是内联配置，不依赖目标端。
 * skills 已由 parseSubagentMarkdown 归一为字符串列表。
 */
function resolveDependencies(agent: {
  skills?: readonly string[];
  mcpServers?: readonly unknown[];
}): DataSyncItemDependencies | undefined {
  const mcpServers = (agent.mcpServers ?? [])
    .filter((spec): spec is string => typeof spec === "string")
    .map((spec) => spec.trim())
    .filter(Boolean);
  const skills = agent.skills ?? [];
  if (mcpServers.length === 0 && skills.length === 0) return undefined;
  return {
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(skills.length > 0 ? { skills: [...skills] } : {}),
  };
}

/**
 * 本端用户子智能体，按 name 转小写对齐。根目录按本端 config.json 的 storage.dir 解析，两端可以不同。
 * 先完成本端 markdown 迁移再读字节：迁移只改写旧 Provider 身份，未迁移的一端与已迁移的一端
 * 内容实际相同，不先迁移就会被误判为「内容不同」。同名时保留排序中的第一个文件。
 */
async function resolveUserSubagents(): Promise<{
  root: string;
  agents: Map<string, ResolvedUserSubagent>;
}> {
  const root = await resolveUserSubagentRoot();
  const migration = await migrateUserSubagentMarkdown(root);
  for (const failure of migration.failures) {
    logger.warn(undefined, "用户 Subagent Markdown 迁移失败，按原文件计算", failure);
  }
  const agents = new Map<string, ResolvedUserSubagent>();
  for (const filePath of await collectAgentMarkdownPaths(root)) {
    const content = await readFile(filePath);
    const parsed = parseSubagentMarkdown({
      content: content.toString("utf-8"),
      path: filePath,
      scope: "user",
    }).agent;
    if (!parsed) continue;
    const key = toSubagentKey(parsed.name);
    if (agents.has(key)) continue;
    const model = parsed.modelSelection?.modelId;
    const dependencies = resolveDependencies(parsed);
    agents.set(key, {
      key,
      name: parsed.name,
      description: model ? `${model} · ${parsed.description}` : parsed.description,
      filePath,
      ...(dependencies ? { dependencies } : {}),
      content,
    });
  }
  return { root, agents };
}
export {
  logger,
  type ResolvedUserSubagent,
  hashContent,
  toSubagentKey,
  resolveDependencies,
  resolveUserSubagents,
};
