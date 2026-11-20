import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ServiceChannels } from "@zcode/shared";
import type { ProjectTask, ProjectTree } from "@zcode/services";
import {
  TID_TASK_ARCHIVE,
  TID_TASK_ITEM,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  appControlToolBlock as toolBlock,
  readAppControlToolResult,
  type AppControlToolEvidence,
} from "#e2e/helpers/app-control-evidence";
import {
  obtainUnreadPairingUrl,
  readMobileTaskView,
  waitMobileTaskView,
} from "#e2e/helpers/web-remote-unread";
import {
  prepareV4ConversationE2E,
  getV4PaneSnapshot,
  renameV4Session,
  selectV4TaskById,
  approveV4Permission,
  waitForV4PermissionDialog,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE = "E2E_SCT07";
const TITLE = "2000字小说创作";
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR!;
const tools: AppControlToolEvidence = {};
const evidence: Record<string, unknown> = { tools };
type SessionRef = {
  kind: "app";
  sourceServerId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  project?: { kind: "app"; sourceServerId: string; projectId: string };
};
type SessionEntry = { session: SessionRef; title: string; availableActions: string[] };
type SearchScope = {
  scopes: Array<{
    kind: "app";
    scope: "host" | "project" | "workspace";
    sourceServerId: string;
    workspacePath?: string;
  }>;
  unavailableSources: unknown[];
};

function toolResult<T>(request: unknown, id: string): T {
  return readAppControlToolResult<T>(request, id, tools);
}

async function readTree() {
  // 只读持久事实用于观测；被测发现必须经 Agent tool runner，不能用此 RPC 代替。
  return callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [{}]);
}

function taskIn(tree: ProjectTree, id: string): ProjectTask {
  const task = tree.tasks.find((item) => item.taskId === id);
  if (!task) throw new Error(`SCT07 real product task missing: ${id}`);
  return task;
}

async function completedTask(marker: string) {
  await sendV4Prompt(buildReadonlyToolPrompt(marker));
  await waitForV4AssistantMessageContaining("upstream-e2e-ok", 90_000);
  const pane = await waitForV4Pane((value) => !value.canStop, "SCT07 setup task still running");
  expect(pane.sessionId).toBeTruthy();
  expect(pane.sessionId).not.toBe("draft");
  return pane.sessionId!;
}
