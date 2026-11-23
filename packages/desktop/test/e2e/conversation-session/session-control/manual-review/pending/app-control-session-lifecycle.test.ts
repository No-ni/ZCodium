import "node:fs/promises";
import "node:path";
import { type Page } from "playwright-core";
import { ServiceChannels } from "@zcode/shared";
import type { ProjectTask, ProjectTree } from "@zcode/services";
import { TID_TASK_ITEM, TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import "#e2e/helpers/desktop-app";
import "#e2e/helpers/conversation-session-readonly-tool";
import "#e2e/helpers/controlled-replay";
import "#e2e/helpers/e2e-electron-reload";
import "#e2e/helpers/mobile-pairing";
import "#e2e/helpers/plugin-management-lifecycle";
import "#e2e/helpers/project-sidebar";
import { callHandoffHost } from "#e2e/helpers/remote-project-handoff-probe";
import {
  readAppControlToolResult,
  type AppControlToolEvidence,
} from "#e2e/helpers/app-control-evidence";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import { showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import {
  approveV4Permission,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE = "E2E_SCT04";
const CALLER_TITLE = "SCT04 调用会话";
const TITLE = "SCT04 生命周期分叉";
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR!;
const tools: AppControlToolEvidence = {};
const assertions: Record<string, unknown> = {};
const evidence = { tools, assertions };
interface SessionRef {
  kind: "app";
  sourceServerId: string;
  workspacePath: string;
  sessionId: string;
  workspaceIdentity?: string;
  project?: { kind: "app"; sourceServerId: string; projectId: string };
}
interface Operation {
  session: SessionRef;
  commandId: string;
}
interface Admission {
  session: SessionRef;
  operation: Operation;
  admission: string;
  delivery: string;
}
interface Creation extends Omit<Admission, "admission"> {
  creation: string;
  firstInput: string;
}
interface History {
  view: "messages";
  session: SessionRef;
  messages: Array<{ id: string; role: string; text: string }>;
  nextCursor?: string;
}
interface Summary {
  view: "summary";
  summary: {
    session: SessionRef;
    status: string;
    executionId?: string;
    title: string;
    archived: boolean;
    pinned: boolean;
  };
}
interface Wait {
  status: string;
  operations: Array<{ operation: Operation; status: string; executionId?: string }>;
}
interface Mutation {
  status: string;
  reason?: string;
}

async function action<T>(key: string, intent: string, approval = false): Promise<T> {
  await sendV4Prompt(
    `${CASE}_ACTION_${key.toUpperCase()}: ${intent} Use complete identities from the earlier actual tool results. Do not navigate or invent a result. After the tool returns reply exactly SCT04_${key.toUpperCase()}_RETURNED.`,
  );
  if (approval) expect(await approveV4Permission()).toBe(true);
  await waitForV4AssistantMessageContaining(`SCT04_${key.toUpperCase()}_RETURNED`, 90_000);
  await waitForV4Pane((value) => !value.canStop, `SCT04 ${key} caller has not completed`);
  const request = (await waitForUpstreamNetworkCapture(`toolu_sct04_${key}`)).requestJson;
  return readAppControlToolResult<T>(request, `toolu_sct04_${key}`, tools);
}
async function mutate(key: string, intent: string) {
  const result = await action<Mutation>(key, intent, true);
  expect(result.status).toBe("applied");
  return result;
}
async function readTask(id: string): Promise<ProjectTask> {
  // 只读 owner 的持久组织事实；被测动作全部来自真实 Agent 工具。
  const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [{}]);
  const task = tree.tasks.find((value) => value.taskId === id);
  if (!task) throw new Error(`SCT04 product task absent: ${id}`);
  return task;
}
function expectOperation(result: Wait, operation: Operation, status: string) {
  expect(
    result.operations.find((value) => value.operation.commandId === operation.commandId),
  ).toMatchObject({ operation, status });
}
async function selectMobile(page: Page, id: string) {
  await showMobileTaskHome(page);
  for (const toggle of await page.getByTestId("virtual-project-toggle").all()) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }
  await page.getByTestId(testId(TID_TASK_ITEM, id)).click();
  await page.locator(`[data-testid^="${TID_V4_SESSION_PANE}-"][data-session-id="${id}"]`).waitFor();
}
