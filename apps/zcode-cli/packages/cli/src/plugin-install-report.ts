import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { ZCodePluginInstallData } from "@zcode/bootstrap";
import {
  formatDiagnosticJson,
  formatDiagnosticLines,
  formatInstalledPluginJson,
  writeWarnings,
} from "./plugins-command-format.js";
import { hasErrors } from "./plugins-command-shared.js";

function reportInstallOutcome(
  ctx: RunContext,
  options: GlobalOptions,
  result: ZCodePluginInstallData,
  pluginId: string,
): number {
  const failed = hasErrors(result.diagnostics);
  if (options.json) {
    ctx.stdout.write(
      formatJson({
        pluginId,
        ok: !failed,
        installed: result.installedPlugins.map(formatInstalledPluginJson),
        dependencyClosure: result.dependencyClosure,
        diagnostics: result.diagnostics.map(formatDiagnosticJson),
      }),
    );
    return failed ? 1 : 0;
  }
  if (failed) {
    ctx.stderr.write(
      `Failed to install plugin ${pluginId}\n${formatDiagnosticLines(result.diagnostics)}`,
    );
    return 1;
  }
  for (const plugin of result.installedPlugins) {
    const version = plugin.version ? ` (${plugin.version})` : "";
    ctx.stdout.write(
      `Installed plugin ${plugin.id}${version} [${plugin.enabled ? "enabled" : "disabled"}]\n`,
    );
  }
  writeWarnings(ctx, result.diagnostics);
  return 0;
}
export { reportInstallOutcome };
