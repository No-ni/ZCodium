import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveCliProcessResourceRole } from "@zcode/shared";

const servicesRoot = dirname(fileURLToPath(import.meta.url));
const agentServicePath = join(servicesRoot, "../src/zcode-agent/zcodeAgentService.ts");

/** 取出 `const <name> = new ZCodeAgentProcessManager({ ... });` 的整个字面量。 */
async function readProcessManagerBlock(managerName: string): Promise<string> {
  const source = await readFile(agentServicePath, "utf8");
  const start = source.indexOf(`const ${managerName} = new ZCodeAgentProcessManager({`);
  assert.notEqual(start, -1, `找不到 ${managerName} 的构造点`);
  const end = source.indexOf("});", start);
  assert.notEqual(end, -1, `${managerName} 的构造块没有闭合`);
  return source.slice(start, end);
}

test("控制面泳道在资源遥测里归入 cli_aux，不落入 cli_chat", () => {
  assert.equal(resolveCliProcessResourceRole("plugin"), "cli_aux");
  assert.equal(resolveCliProcessResourceRole("mcp-status"), "cli_aux");
  assert.equal(resolveCliProcessResourceRole("chat"), "cli_chat");
  // 缺省（版本落后、未打 lane 的远端样本）按契约归 cli_chat；本仓库的泳道必须显式打标。
  assert.equal(resolveCliProcessResourceRole(undefined), "cli_chat");
});

test("plugin 泳道带 lane 标签和空闲回收阈值", async () => {
  const block = await readProcessManagerBlock("pluginProcessManager");
  assert.match(block, /lane:\s*"plugin"/, "plugin 泳道必须显式打 lane 标签");
  assert.match(block, /idleTimeoutMs:/, "plugin 泳道必须配置空闲回收");
});

test("mcp-status 泳道保持 lane 标签和空闲回收阈值", async () => {
  const block = await readProcessManagerBlock("mcpStatusProcessManager");
  assert.match(block, /lane:\s*"mcp-status"/);
  assert.match(block, /idleTimeoutMs:/);
});

test("chat 会话进程不配置空闲回收", async () => {
  // chat 的进程管理器由 workspace 级 getClient 路径创建；这里断言三个控制面管理器之外
  // 没有第四处把 idleTimeoutMs 传给 chat。真正的约束是：idleTimeoutMs 只可能来自
  // options.pluginLaneIdleTimeoutMs / options.mcpStatusIdleTimeoutMs 两个入口。
  const source = await readFile(agentServicePath, "utf8");
  const chatManagers =
    source.match(/new ZCodeAgentProcessManager\(\{[^}]*\bidleTimeoutMs\b/g) ?? [];
  assert.equal(
    chatManagers.length,
    2,
    "只允许 plugin 与 mcp-status 两个控制面管理器配置 idleTimeoutMs",
  );
});
