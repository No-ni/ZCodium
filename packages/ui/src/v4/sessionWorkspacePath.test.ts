import { describe, expect, it } from "vitest";
import type { FileReferenceRoot } from "@/lib/fileReferenceRoot.js";
import {
  readSessionWorkspacePath,
  resolveEffectiveWorkspacePath,
  resolvePaneFileSearchRoot,
} from "./sessionWorkspacePath.js";

// 会话 cwd 的唯一来源是 conversation snapshot 的 additive 可选字段 `workspacePath`
// （见 docs/specs/conversation-session-workspace.md 的所有者表）：
// 有字段用会话 cwd，缺席（旧 CLI、旧快照、草稿未绑定）回落 tab 的 workspacePath。
// 这里固定这两条规则，防止回落逻辑散落回各消费点。

const TAB_WORKSPACE_PATH = "/Users/me/.zcodium/workspace/default";
const SESSION_WORKSPACE_PATH = "/Users/me/.zcodium/workspace/default/2026-10-11/a1b2c3d4";

describe("readSessionWorkspacePath", () => {
  it("读取快照投影的会话执行 cwd", () => {
    expect(readSessionWorkspacePath({ workspacePath: SESSION_WORKSPACE_PATH })).toBe(
      SESSION_WORKSPACE_PATH,
    );
  });

  it("旧 CLI / 旧快照缺席字段时返回 null", () => {
    expect(readSessionWorkspacePath(null)).toBeNull();
    expect(readSessionWorkspacePath({})).toBeNull();
    expect(readSessionWorkspacePath({ workspacePath: undefined })).toBeNull();
  });

  it("空白值不当作会话 cwd", () => {
    expect(readSessionWorkspacePath({ workspacePath: "" })).toBeNull();
    expect(readSessionWorkspacePath({ workspacePath: "   " })).toBeNull();
  });

  it("去掉首尾空白，避免把带空格的路径带进文件操作", () => {
    expect(readSessionWorkspacePath({ workspacePath: ` ${SESSION_WORKSPACE_PATH} ` })).toBe(
      SESSION_WORKSPACE_PATH,
    );
  });
});

describe("resolveEffectiveWorkspacePath", () => {
  it("会话已绑定时用会话 cwd", () => {
    expect(resolveEffectiveWorkspacePath(SESSION_WORKSPACE_PATH, TAB_WORKSPACE_PATH)).toBe(
      SESSION_WORKSPACE_PATH,
    );
  });

  it("会话未绑定时回落 tab 的 workspacePath（工作区身份不变）", () => {
    expect(resolveEffectiveWorkspacePath(null, TAB_WORKSPACE_PATH)).toBe(TAB_WORKSPACE_PATH);
    expect(resolveEffectiveWorkspacePath("", TAB_WORKSPACE_PATH)).toBe(TAB_WORKSPACE_PATH);
    expect(resolveEffectiveWorkspacePath("   ", TAB_WORKSPACE_PATH)).toBe(TAB_WORKSPACE_PATH);
  });
});

// pane（SessionPane）内的文件搜索 / 相对路径解析根。
//
// 与 shell 侧的 `useSessionWorkspacePath` 的差别就是草稿态：shell 只认 `activeTaskId`
// （草稿态 null → 对话根，见 spec 已知边界 2），而 pane 的 lease 是按
// `effectiveSessionId = sessionId ?? prewarmSessionId` 获取的——草稿态订阅的是预热会话，
// 它就是要承载首发的会话。不认这个 id，草稿期 `@` 提及 / 拖拽就会插入**身份根相对路径**，
// 首发后模型按自己的 cwd（会话目录）解析不到（改动前会话 cwd = 身份根，旧行为才是对的）。
const SESSION_A = `${TAB_WORKSPACE_PATH}/2026-10-11/a1b2c3d4`;
const SESSION_PREWARM = `${TAB_WORKSPACE_PATH}/2026-10-11/bbccddee`;
const SESSION_OTHER = `${TAB_WORKSPACE_PATH}/2026-10-11/11223344`;

function resolvePane(params: {
  snapshot: { sessionId: string; workspacePath?: string } | null;
  sessionId: string | null;
  prewarmSessionId: string | null;
}): FileReferenceRoot {
  return resolvePaneFileSearchRoot({
    snapshot: params.snapshot,
    sessionId: params.sessionId,
    prewarmSessionId: params.prewarmSessionId,
    tabWorkspacePath: TAB_WORKSPACE_PATH,
  });
}

function paneRoot(params: Parameters<typeof resolvePane>[0]): string {
  return resolvePane(params).rootPath;
}

function paneRootResolved(params: Parameters<typeof resolvePane>[0]): boolean {
  return resolvePane(params).resolved;
}

describe("resolvePaneFileSearchRoot", () => {
  it("草稿态（sessionId 为 null）但有预热会话 → 用预热会话的会话目录（回归修复点）", () => {
    const snapshot = { sessionId: "sess_prewarm", workspacePath: SESSION_PREWARM };
    const boundSessionId: string | null = null;

    expect(
      paneRoot({ snapshot, sessionId: boundSessionId, prewarmSessionId: "sess_prewarm" }),
    ).toBe(SESSION_PREWARM);
    // 旧实现只按绑定 id 校验身份（`snapshot?.sessionId === sessionId`），草稿态因此回落身份根。
    // 对照行必须**同样走被测函数**：拿掉预热 id 后仍要回落，两行合起来才证明解析根确实来自
    // `prewarmSessionId`，而不是任何「有快照就用它」的兜底。早先这里在测试里自己重写了一遍旧
    // 判据（`snapshot.sessionId === boundSessionId ? snapshot : null`）再断言回落——恒真，
    // 把被测函数整个删掉也照样绿。
    expect(paneRoot({ snapshot, sessionId: boundSessionId, prewarmSessionId: null })).toBe(
      TAB_WORKSPACE_PATH,
    );
  });

  it("预热会话提升为正式会话（id 与目录都不变）→ 不闪：草稿帧与绑定帧同一个根", () => {
    const draftRoot = paneRoot({
      snapshot: { sessionId: "sess_prewarm", workspacePath: SESSION_PREWARM },
      sessionId: null,
      prewarmSessionId: "sess_prewarm",
    });
    const boundRoot = paneRoot({
      snapshot: { sessionId: "sess_prewarm", workspacePath: SESSION_PREWARM },
      sessionId: "sess_prewarm",
      prewarmSessionId: null,
    });

    expect(draftRoot).toBe(SESSION_PREWARM);
    expect(boundRoot).toBe(draftRoot);
  });

  it("草稿态尚未预热（没有预热 id）→ 回落 tab 的 workspacePath，且标记为「未被会话事实证明」", () => {
    expect(
      paneRoot({
        snapshot: null,
        sessionId: null,
        prewarmSessionId: null,
      }),
    ).toBe(TAB_WORKSPACE_PATH);
    expect(
      paneRootResolved({
        snapshot: null,
        sessionId: null,
        prewarmSessionId: null,
      }),
    ).toBe(false);
    // 预热还没就绪时 lease 仍是上一个已绑定会话：快照身份不符，不能借它的目录。
    expect(
      paneRoot({
        snapshot: { sessionId: "sess_other", workspacePath: SESSION_OTHER },
        sessionId: null,
        prewarmSessionId: null,
      }),
    ).toBe(TAB_WORKSPACE_PATH);
    expect(
      paneRootResolved({
        snapshot: { sessionId: "sess_other", workspacePath: SESSION_OTHER },
        sessionId: null,
        prewarmSessionId: null,
      }),
    ).toBe(false);
  });

  it("从已绑定会话切回草稿的首帧（快照还是上一个会话）→ 回落 tab 路径，不借旧会话目录", () => {
    expect(
      paneRoot({
        snapshot: { sessionId: "sess_other", workspacePath: SESSION_OTHER },
        sessionId: null,
        prewarmSessionId: "sess_prewarm",
      }),
    ).toBe(TAB_WORKSPACE_PATH);
    // 首帧的回落根不能当作会话事实：提及必须走绝对路径，否则会被首发会话按新目录解析。
    expect(
      paneRootResolved({
        snapshot: { sessionId: "sess_other", workspacePath: SESSION_OTHER },
        sessionId: null,
        prewarmSessionId: "sess_prewarm",
      }),
    ).toBe(false);
  });

  it("会话已绑定 → 用该会话的目录；切会话首帧的旧快照仍回落 tab 路径", () => {
    expect(
      paneRoot({
        snapshot: { sessionId: "sess_a", workspacePath: SESSION_A },
        sessionId: "sess_a",
        prewarmSessionId: null,
      }),
    ).toBe(SESSION_A);
    expect(
      paneRootResolved({
        snapshot: { sessionId: "sess_a", workspacePath: SESSION_A },
        sessionId: "sess_a",
        prewarmSessionId: null,
      }),
    ).toBe(true);
    expect(
      paneRoot({
        snapshot: { sessionId: "sess_a", workspacePath: SESSION_A },
        sessionId: "sess_other",
        prewarmSessionId: null,
      }),
    ).toBe(TAB_WORKSPACE_PATH);
    expect(
      paneRootResolved({
        snapshot: { sessionId: "sess_a", workspacePath: SESSION_A },
        sessionId: "sess_other",
        prewarmSessionId: null,
      }),
    ).toBe(false);
  });

  it("快照缺 workspacePath（项目/远端会话、旧 CLI、降级）→ 回落 tab 路径，但这是**已证明**的根", () => {
    // 这类会话没有独立执行目录，Agent cwd 恒等于工作区键路径 = 回落根本身（规则 6），
    // 因此 resolved 必须为 true：投相对路径是安全的，也正是改动前的项目工作区行为。
    expect(
      paneRoot({
        snapshot: { sessionId: "sess_prewarm" },
        sessionId: null,
        prewarmSessionId: "sess_prewarm",
      }),
    ).toBe(TAB_WORKSPACE_PATH);
    expect(
      paneRootResolved({
        snapshot: { sessionId: "sess_prewarm" },
        sessionId: null,
        prewarmSessionId: "sess_prewarm",
      }),
    ).toBe(true);
    expect(
      paneRoot({
        snapshot: { sessionId: "sess_a" },
        sessionId: "sess_a",
        prewarmSessionId: null,
      }),
    ).toBe(TAB_WORKSPACE_PATH);
    expect(
      paneRootResolved({
        snapshot: { sessionId: "sess_a" },
        sessionId: "sess_a",
        prewarmSessionId: null,
      }),
    ).toBe(true);
    expect(
      paneRoot({
        snapshot: { sessionId: "sess_a", workspacePath: "   " },
        sessionId: "sess_a",
        prewarmSessionId: null,
      }),
    ).toBe(TAB_WORKSPACE_PATH);
    expect(
      paneRootResolved({
        snapshot: { sessionId: "sess_a", workspacePath: "   " },
        sessionId: "sess_a",
        prewarmSessionId: null,
      }),
    ).toBe(true);
  });
});
