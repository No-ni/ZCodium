import { describe, expect, it } from "vitest";
import {
  openWorkflowArtifactSidePane,
  openWorkflowRunSidePane,
  openWorkflowWorkspaceSidePane,
  type WorkflowArtifactSidePaneTab,
  type WorkflowRunSidePaneTab,
  type WorkflowWorkspaceSidePaneTab,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";

// 产物 `sourcePath` 是相对 run 的 cwd（= 发起打开的会话执行目录）产出的，解析根属于**这次请求**，
// 不属于壳层焦点：宿主 `AnimatedSidePanePanel` 过去一律用 `effectiveWorkspacePath`（聚焦会话 cwd，
// 会话未绑定/快照未到时回落对话根），于是卡片上的真实路径与「在工作区显示」会指向对话根下的同名
// 位置。这里钉住「打开时把发起 pane 的根冻结到 tab 上」这条契约（见 spec 已知边界 17）。
const CONVERSATION_ROOT = "/Users/me/.zcodium/workspace/default";
const SESSION_DIR = `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4`;
const PARENT_SESSION_ID = "sess_a1b2c3d4-0000-4000-8000-000000000000";

function openArtifact(
  current: WorkspaceSidePaneState | null,
  overrides: { fileReferenceRootPath?: string } = {},
): { state: WorkspaceSidePaneState; tab: WorkflowArtifactSidePaneTab } {
  const state = openWorkflowArtifactSidePane(current, {
    workspaceKey: "default",
    workspacePath: CONVERSATION_ROOT,
    parentSessionId: PARENT_SESSION_ID,
    runId: "run-a1b2c3d4",
    artifactId: "report",
    ...overrides,
  });
  const tab = state.tabs.find(
    (candidate): candidate is WorkflowArtifactSidePaneTab => candidate.type === "workflow-artifact",
  );
  expect(tab).toBeDefined();
  return { state, tab: tab as WorkflowArtifactSidePaneTab };
}

describe("workflow 产物 tab 的解析根", () => {
  it("请求带解析根时冻结到 tab 上", () => {
    expect(
      openArtifact(null, { fileReferenceRootPath: SESSION_DIR }).tab.fileReferenceRootPath,
    ).toBe(SESSION_DIR);
  });

  it("请求不带解析根时字段缺席（旧发送端 / 中枢入口）：由宿主回落聚焦会话 cwd", () => {
    expect(openArtifact(null).tab.fileReferenceRootPath).toBeUndefined();
  });

  it("同一产物再次打开：新请求带根则补上，不带根则保留既有根（不丢已知事实）", () => {
    const opened = openArtifact(null, { fileReferenceRootPath: SESSION_DIR });
    const reopenedWithoutRoot = openArtifact(opened.state);
    expect(reopenedWithoutRoot.state.tabs).toHaveLength(1);
    expect(reopenedWithoutRoot.tab.fileReferenceRootPath).toBe(SESSION_DIR);

    const reopenedFromOtherRequest = openArtifact(opened.state, {
      fileReferenceRootPath: `${CONVERSATION_ROOT}/2026-10-10/ffffffff`,
    });
    expect(reopenedFromOtherRequest.state.tabs).toHaveLength(1);
    expect(reopenedFromOtherRequest.tab.fileReferenceRootPath).toBe(
      `${CONVERSATION_ROOT}/2026-10-10/ffffffff`,
    );
  });
});

// run 详情与脚本 transcript 两个 tab 是同一判据的第二、三处：详情里的产物 chip 要拼 `sourcePath`，
// transcript 的 Read 卡要把 `path` 拼成绝对路径，两者的基准都是 run 的 cwd（会话执行目录）。
// 不带根时宿主只能按工作区身份根（对话会话里是对话根）拼，html 产物 404 或打开同名错文件。
describe("run 详情 / 脚本 transcript tab 的解析根", () => {
  const RUN_SCOPE = {
    workspaceKey: "default",
    workspacePath: CONVERSATION_ROOT,
    parentSessionId: PARENT_SESSION_ID,
    toolCallId: "call-a1b2c3d4",
    runId: "run-a1b2c3d4",
  } as const;

  it("run tab 打开时冻结请求根；缺席即不写该字段", () => {
    const withRoot = openWorkflowRunSidePane(null, {
      ...RUN_SCOPE,
      fileReferenceRootPath: SESSION_DIR,
    });
    const runTab = withRoot.tabs.find(
      (candidate): candidate is WorkflowRunSidePaneTab => candidate.type === "workflow-run",
    );
    expect(runTab?.fileReferenceRootPath).toBe(SESSION_DIR);

    const withoutRoot = openWorkflowRunSidePane(null, RUN_SCOPE);
    const bareTab = withoutRoot.tabs.find(
      (candidate): candidate is WorkflowRunSidePaneTab => candidate.type === "workflow-run",
    );
    expect(bareTab?.fileReferenceRootPath).toBeUndefined();
  });

  it("脚本 transcript tab 打开时冻结请求根；再次打开时保留既有根", () => {
    const opened = openWorkflowWorkspaceSidePane(null, {
      ...RUN_SCOPE,
      fileReferenceRootPath: SESSION_DIR,
    });
    const workspaceTab = opened.tabs.find(
      (candidate): candidate is WorkflowWorkspaceSidePaneTab =>
        candidate.type === "workflow-workspace",
    );
    expect(workspaceTab?.fileReferenceRootPath).toBe(SESSION_DIR);

    const reopened = openWorkflowWorkspaceSidePane(opened, RUN_SCOPE);
    expect(reopened.tabs).toHaveLength(1);
    const reopenedTab = reopened.tabs.find(
      (candidate): candidate is WorkflowWorkspaceSidePaneTab =>
        candidate.type === "workflow-workspace",
    );
    expect(reopenedTab?.fileReferenceRootPath).toBe(SESSION_DIR);
  });
});
