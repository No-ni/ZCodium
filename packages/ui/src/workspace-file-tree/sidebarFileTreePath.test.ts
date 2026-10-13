import { describe, expect, it } from "vitest";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  resolveSidebarFileTreePath,
  type SidebarFileTreeTarget,
} from "@/workspace-file-tree/sidebarFileTreePath.js";

// 侧栏文件树根的两分法（见 docs/specs/conversation-session-workspace.md 规则 4 与已知边界 4）：
// - 默认（会话已绑定）树根 = 会话执行 cwd；
// - 仅当这一次 reveal 的目标落在「工作区身份根内、会话目录外」时，树根切回身份根，
//   否则 WorkspaceFileTree 的包含判定会直接 return，树不展开也没有反馈；
// - 其余情况（key 不匹配 / 无会话 / reveal 在两者之外）保持改动前行为。

const CONVERSATION_ROOT = "/Users/me/.zcodium/workspace/default";
const SESSION_DIR = `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4`;
/** 同一个对话根下的**另一个**会话目录（另一天/另一个 id）。 */
const OTHER_SESSION_DIR = `${CONVERSATION_ROOT}/2026-10-10/ffffffff`;
const OTHER_WORKSPACE = "/Users/me/Projects/demo";
const EXTERNAL_DIR = "/tmp/loose-report";

function createTarget(overrides: Partial<SidebarFileTreeTarget> = {}): SidebarFileTreeTarget {
  return {
    workspacePath: CONVERSATION_ROOT,
    workspaceName: "Default",
    ...overrides,
  };
}

const ACTIVE_TASK_ID = "sess_a1b2c3d4-0000-4000-8000-000000000000";
const OTHER_TASK_ID = "sess_ffffffff-0000-4000-8000-000000000000";

/** 调用点用 buildTaskWorkspaceKey(workspacePath, workspaceIdentity) 生成 activeWorkspaceKey。 */
function resolve(params: {
  target: SidebarFileTreeTarget;
  activeWorkspaceKey?: string;
  activeTaskId?: string | null;
  activeSessionWorkspacePath?: string | null;
}): string {
  const base = {
    target: params.target,
    // 显式传入才算覆盖（含 null = 草稿态）：默认是「激活会话已绑定」。
    activeTaskId: "activeTaskId" in params ? (params.activeTaskId ?? null) : ACTIVE_TASK_ID,
    activeWorkspaceKey:
      params.activeWorkspaceKey ??
      buildTaskWorkspaceKey(CONVERSATION_ROOT, params.target.workspaceIdentity),
  };
  // 显式传入才算覆盖（含 null / undefined）：默认是「会话已绑定」。
  return resolveSidebarFileTreePath(
    "activeSessionWorkspacePath" in params
      ? { ...base, activeSessionWorkspacePath: params.activeSessionWorkspacePath ?? null }
      : { ...base, activeSessionWorkspacePath: SESSION_DIR },
  );
}

describe("resolveSidebarFileTreePath", () => {
  it("会话已绑定且 reveal 在会话目录内时用会话目录", () => {
    expect(
      resolve({
        target: createTarget({ revealPath: `${SESSION_DIR}/src/app.ts` }),
      }),
    ).toBe(SESSION_DIR);
  });

  it("reveal 命中会话目录本身（边界相等）时用会话目录", () => {
    expect(resolve({ target: createTarget({ revealPath: SESSION_DIR }) })).toBe(SESSION_DIR);
    expect(resolve({ target: createTarget({ revealPath: `${SESSION_DIR}/` }) })).toBe(SESSION_DIR);
  });

  it("reveal 在身份根内但在会话目录外（如 .zcodium-share）时切回身份根", () => {
    expect(
      resolve({
        target: createTarget({ revealPath: `${CONVERSATION_ROOT}/.zcodium-share/report.md` }),
      }),
    ).toBe(CONVERSATION_ROOT);
  });

  it("reveal 是身份根自己（对话根文件）时切回身份根", () => {
    expect(resolve({ target: createTarget({ revealPath: CONVERSATION_ROOT }) })).toBe(
      CONVERSATION_ROOT,
    );
  });

  it("reveal 在会话目录与身份根之外（临时外部目录）时保持现状：仍用会话目录", () => {
    expect(resolve({ target: createTarget({ revealPath: `${EXTERNAL_DIR}/note.md` }) })).toBe(
      SESSION_DIR,
    );
  });

  it("任务行是自己会话（taskId = activeTaskId）时用会话目录", () => {
    expect(resolve({ target: createTarget({ taskId: ACTIVE_TASK_ID }) })).toBe(SESSION_DIR);
  });

  it("任务行是同一 workspace 的**另一个**会话时用目标自身的工作区路径（不借用激活会话目录）", () => {
    // 对话工作区里每个会话的 workspacePath 都是对话根 ⇒ workspaceKey 相等，只有 taskId 能区分。
    // 回归形态：借用激活会话目录会让用户点 B 的文件树却看到 A 的文件（拖拽/Add to chat 也拿 A 的）。
    expect(resolve({ target: createTarget({ taskId: OTHER_TASK_ID }) })).toBe(CONVERSATION_ROOT);
    expect(
      resolve({
        target: createTarget({
          taskId: OTHER_TASK_ID,
          revealPath: `${SESSION_DIR}/src/app.ts`,
        }),
      }),
    ).toBe(CONVERSATION_ROOT);
  });

  it("任务行但会话未绑定（草稿态 activeTaskId = null）时用目标自身的工作区路径", () => {
    expect(resolve({ target: createTarget({ taskId: ACTIVE_TASK_ID }), activeTaskId: null })).toBe(
      CONVERSATION_ROOT,
    );
  });

  it("reveal 命中的是**另一个**会话的目录时不换根：这不是当前 tab 的树", () => {
    // 分屏/多会话下 reveal 可能来自别的 pane：只有落在**当前激活会话**目录内才换根。
    // 不校验就会把侧栏文件树切到另一个会话的目录（等于借用别的会话的树）。
    expect(
      resolve({
        target: createTarget({ revealPath: `${OTHER_SESSION_DIR}/src/app.ts` }),
        activeSessionWorkspacePath: SESSION_DIR,
      }),
    ).toBe(CONVERSATION_ROOT);
  });

  it("key 不匹配（其它 workspace tab / 任务行）时用目标自身的工作区路径", () => {
    expect(
      resolve({
        target: createTarget({
          workspacePath: OTHER_WORKSPACE,
          workspaceName: "demo",
          revealPath: `${OTHER_WORKSPACE}/src/app.ts`,
        }),
      }),
    ).toBe(OTHER_WORKSPACE);
  });

  it("workspacePath 相同但 workspaceIdentity 不同时 key 不匹配，即使 reveal 在会话目录内也不用会话目录", () => {
    expect(
      resolve({
        target: createTarget({
          workspaceIdentity: "remote-1",
          revealPath: `${SESSION_DIR}/src/app.ts`,
        }),
        activeWorkspaceKey: buildTaskWorkspaceKey(CONVERSATION_ROOT, "remote-2"),
      }),
    ).toBe(CONVERSATION_ROOT);
  });

  it("无 activeSessionWorkspacePath（草稿 / 旧 CLI / 首帧）时回落目标工作区路径", () => {
    for (const value of [null, undefined, ""]) {
      expect(
        resolve({
          target: createTarget({ revealPath: `${SESSION_DIR}/src/app.ts` }),
          activeSessionWorkspacePath: value,
        }),
      ).toBe(CONVERSATION_ROOT);
    }
  });

  it("revealPath 缺席或空白时用会话目录", () => {
    expect(resolve({ target: createTarget() })).toBe(SESSION_DIR);
    expect(resolve({ target: createTarget({ revealPath: "" }) })).toBe(SESSION_DIR);
    expect(resolve({ target: createTarget({ revealPath: "   " }) })).toBe(SESSION_DIR);
  });

  it("临时外部目录（key 不匹配）时树根就是目标自身路径，reveal 不外溢", () => {
    const external = "/tmp/some-external-dir";
    expect(
      resolve({
        target: {
          workspacePath: external,
          workspaceName: "external",
          revealPath: `${external}/notes.md`,
          temporaryExternalDirectory: true,
        },
      }),
    ).toBe(external);
  });

  it("Windows 分隔符与尾斜杠按既有路径归一化判定", () => {
    const windowsRoot = "C:\\Users\\me\\.zcodium\\workspace\\default";
    const windowsSession = `${windowsRoot}\\2026-10-11\\a1b2c3d4`;
    expect(
      resolve({
        target: createTarget({ workspacePath: windowsRoot, revealPath: `${windowsSession}\\src` }),
        activeWorkspaceKey: buildTaskWorkspaceKey(windowsRoot),
        activeSessionWorkspacePath: windowsSession,
      }),
    ).toBe(windowsSession);
    expect(
      resolve({
        target: createTarget({
          workspacePath: `${windowsRoot}/`,
          revealPath: "C:/Users/me/.zcodium/workspace/default/.zcodium-share/report.md",
        }),
        activeWorkspaceKey: buildTaskWorkspaceKey(windowsRoot),
        activeSessionWorkspacePath: windowsSession,
      }),
    ).toBe(`${windowsRoot}/`);
  });
});
