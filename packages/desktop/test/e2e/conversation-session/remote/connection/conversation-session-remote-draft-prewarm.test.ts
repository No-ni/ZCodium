import "node:fs/promises";
import "node:path";
import "playwright-core";
import "@zcode/shared";
import "@zcode/shared/test-ids";
import "#e2e/helpers/conversation-session-network";
import "#e2e/helpers/custom-openai-provider";
import "#e2e/helpers/desktop-app";
import "#e2e/helpers/e2e-electron-reload";
import "#e2e/helpers/mobile-pairing";
import "#e2e/helpers/remote-project-actions";
import "#e2e/helpers/remote-project-handoff-probe";
import "#e2e/helpers/ssh-remote-lifecycle";
import "#e2e/helpers/ssh-remote-p0";
import "#e2e/helpers/upstream-provider";
import "#e2e/helpers/v4-conversation";
import "#e2e/helpers/web-remote-unread";
import "#e2e/helpers/workspace-agent-warmup";

const CASE = "E2E_REMOTE_DRAFT_PREWARM";
const REPLY = "REMOTE_DRAFT_PREWARM_REPLY";
type Address = { path: string; identity?: string };
type Ack = { type: string; status: string; reasonCode?: string };
type ProbeWindow = Window & {
  __zcodeV4CommandAcksE2E?: Ack[];
  __zcodeTabStoreE2E?: {
    getState(): { activeWorkspacePath: string; activeWorkspaceIdentity?: string };
  };
  __zcodeSessionStoreE2E?: {
    getState(): {
      getWorkspaceState(
        path: string,
        identity?: string,
      ): { activeTaskId: string | null; draftProjectId?: string | null };
      startDraft(
        path: string,
        provider: undefined,
        identity: string,
        options: { projectId: null },
      ): void;
    };
  };
};

// 同时读取实际 Composer、workspace owner 与真实命令回执，不用模拟 createSession 结果。
function readDraft(address?: Address) {
  const w = window as ProbeWindow;
  const tab = w.__zcodeTabStoreE2E!.getState();
  const path = address?.path ?? tab.activeWorkspacePath;
  const identity = address?.identity ?? tab.activeWorkspaceIdentity;
  const state = w.__zcodeSessionStoreE2E!.getState().getWorkspaceState(path, identity);
  return {
    path,
    identity,
    activeTaskId: state.activeTaskId,
    projectId: state.draftProjectId ?? null,
    createAcks: (w.__zcodeV4CommandAcksE2E ?? []).filter((a) => a.type === "createSession"),
  };
}
function clearAcks() {
  (window as ProbeWindow).__zcodeV4CommandAcksE2E = [];
}

function assertNoCreateErrors(facts: ReturnType<typeof readDraft>) {
  expect(facts.createAcks.filter((a) => a.status !== "accepted")).toEqual([]);
}
