import type { LoggerFactory } from "@zcode/contracts";
import { type LoadedConfig } from "./file-config.adapter.js";
import { createNodeLoggerFactory } from "../logging/index.js";

function logConfigDiagnostics(input: {
  env?: Record<string, string | undefined>;
  loggerFactory?: LoggerFactory;
  projectDiagnostics: LoadedConfig["diagnostics"];
  userDiagnostics: LoadedConfig["diagnostics"];
}): void {
  const diagnostics = [
    ...input.userDiagnostics.map((diagnostic) => ({ ...diagnostic, configScope: "user" })),
    ...input.projectDiagnostics.map((diagnostic) => ({ ...diagnostic, configScope: "project" })),
  ];
  if (diagnostics.length === 0) return;

  const loggerFactory = input.loggerFactory ?? createNodeLoggerFactory({ env: input.env });
  const logger = loggerFactory.createLogger("zcode").child({ module: "adapters.config" });

  for (const diagnostic of diagnostics) {
    // 注入的 logger 也属于外部出口：路径及诊断原文只留在配置返回值，不能依赖下游兜底脱敏。
    logger.warn(resolveConfigDiagnosticLogMessage(diagnostic.code), {
      status: "failed",
      errorCategory: "validation",
      count: 1,
    });
  }
}

function resolveConfigDiagnosticLogMessage(
  code: LoadedConfig["diagnostics"][number]["code"],
): string {
  if (code === "config_mcp_server_invalid") return "MCP server config skipped";
  if (code === "config_project_hooks_pending_trust") {
    return "Project hooks pending workspace trust";
  }
  return "Config file failed to load";
}

function resolveConfigDiagnosticLogEvent(
  code: LoadedConfig["diagnostics"][number]["code"],
): string {
  if (code === "config_mcp_server_invalid") return "config.mcp_server.skipped";
  if (code === "config_project_hooks_pending_trust") {
    return "config.project_hooks.pending_trust";
  }
  return "config.file.invalid";
}
export { logConfigDiagnostics, resolveConfigDiagnosticLogMessage, resolveConfigDiagnosticLogEvent };
