import { isExtensionError } from "@zcode/shared/extension-host";
import type { ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgent.js";

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const workspaceKeyOf = (target: ZCodeAgentWorkspaceTarget) =>
  target.workspaceIdentity?.trim() || target.workspacePath;

const describe = (error: unknown) =>
  isExtensionError(error)
    ? error.code
    : (((error as { code?: unknown } | null)?.code as string | undefined) ??
      (error instanceof Error ? error.name : typeof error));
export { jsonBytes, workspaceKeyOf, describe };
