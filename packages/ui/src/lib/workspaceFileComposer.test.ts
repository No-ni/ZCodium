import { describe, expect, it, vi } from "vitest";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import {
  createWorkspaceFileComposerMention,
  readWorkspaceFileDragPayload,
  serializeWorkspaceFileDragPayload,
  WORKSPACE_FILE_DRAG_MIME,
  type WorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";
import { resolvePaneFileSearchRoot } from "@/v4/sessionWorkspacePath.js";

// 拖拽 / Add to chat 的「同源」判据（见 docs/specs/conversation-session-workspace.md 已知边界 14）。
//
// 背景：payload 的 `workspacePath` 是**工作区身份**（对话根），`relativePath` 是相对**文件树
// 浏览根**的路径。对话会话下文件树根 = 会话执行 cwd，与身份根不是同一个目录；只按身份判同源
// 会把 A 会话树里的相对路径投给 B 会话的 composer，而 B 会话的 Agent 按**自己的** cwd 解析它
// → 错文件或不存在。
//
// 结论（本文件固定这五类场景）：
// 1. 同 workspace 身份 + 解析根相等 → 相对路径；
// 2. 同 workspace 身份 + 解析根不同（同 workspace 的另一个会话 / 树被重挂到身份根）→ 绝对路径；
// 3. 异 workspace 身份 → 绝对路径（改动前行为，回归）；
// 4. payload 缺 `fileReferenceRootPath` 的旧数据 → 按 `payload.workspacePath` 归一化后比较，
//    相等用相对路径、不等用绝对路径；
// 5. composer 侧解析根**未被会话事实证明**（`fileReferenceRootResolved: false`）→ 绝对路径，
//    即使两侧归一化后相等（草稿态预热未就绪：接收方会话还没铸出执行目录）。

const CONVERSATION_ROOT = "/Users/me/.zcodium/workspace/default";
const SESSION_A = `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4`;
const SESSION_B = `${CONVERSATION_ROOT}/2026-10-11/e5f6a7b8`;
const PROJECT_ROOT = "/Users/me/Projects/demo";

function createPayload(
  overrides: Partial<WorkspaceFileDragPayload> = {},
): WorkspaceFileDragPayload {
  return {
    type: "file",
    workspacePath: CONVERSATION_ROOT,
    fileReferenceRootPath: SESSION_A,
    path: `${SESSION_A}/src/app.ts`,
    relativePath: "src/app.ts",
    name: "app.ts",
    ...overrides,
  };
}

/** 缺 `fileReferenceRootPath` 的旧形态 payload（字段真的不存在，不是 undefined）。 */
function createLegacyPayload(
  overrides: Partial<Omit<WorkspaceFileDragPayload, "fileReferenceRootPath">> = {},
): WorkspaceFileDragPayload {
  return {
    type: "file",
    workspacePath: CONVERSATION_ROOT,
    path: `${CONVERSATION_ROOT}/.zcodium-share/report.md`,
    relativePath: ".zcodium-share/report.md",
    name: "report.md",
    ...overrides,
  };
}

function readPayloadFromRaw(raw: unknown): WorkspaceFileDragPayload | null {
  return readWorkspaceFileDragPayload({
    types: [WORKSPACE_FILE_DRAG_MIME],
    getData: (format: string) => (format === WORKSPACE_FILE_DRAG_MIME ? JSON.stringify(raw) : ""),
  } as unknown as DataTransfer);
}

describe("createWorkspaceFileComposerMention 同源判据", () => {
  it("1. 同 workspace 身份 + 解析根相等 → 用 relativePath", () => {
    const mention = createWorkspaceFileComposerMention(
      createPayload(),
      CONVERSATION_ROOT,
      undefined,
      SESSION_A,
    );

    expect(mention.value).toBe("src/app.ts");
    expect(mention.data.relativePath).toBe("src/app.ts");
    expect(mention.markdown).toContain("(./src/app.ts)");
    // 绝对路径始终留在 data.path 里，供打开与回退使用。
    expect(mention.data.path).toBe(`${SESSION_A}/src/app.ts`);
    expect(mention.data.kind).toBe("file");
  });

  it("2. 同 workspace 身份 + 解析根不同（会话 A 的树投给会话 B 的 composer）→ 用绝对路径", () => {
    const mention = createWorkspaceFileComposerMention(
      createPayload(),
      CONVERSATION_ROOT,
      undefined,
      SESSION_B,
    );

    expect(mention.value).toBe(`${SESSION_A}/src/app.ts`);
    expect(mention.data.relativePath).toBe(`${SESSION_A}/src/app.ts`);
    expect(mention.markdown).toContain(`[app.ts](${SESSION_A}/src/app.ts)`);
  });

  it("5. composer 解析根未被会话事实证明 → 两侧根相等也投绝对路径（草稿预热未就绪）", () => {
    // 与第 1 条**只差**第 5 个入参：payload 与 composer 都归一化成身份根，但接收这批内容的
    // 会话还没有自己的执行目录，相对路径会被首发会话按新铸的会话目录解析 → 找不到文件。
    const payload = createLegacyPayload();
    const sameRoots = createWorkspaceFileComposerMention(
      payload,
      CONVERSATION_ROOT,
      undefined,
      CONVERSATION_ROOT,
      { fileReferenceRootResolved: true },
    );
    expect(sameRoots.value).toBe(".zcodium-share/report.md");

    const unproven = createWorkspaceFileComposerMention(
      payload,
      CONVERSATION_ROOT,
      undefined,
      CONVERSATION_ROOT,
      { fileReferenceRootResolved: false },
    );
    expect(unproven.value).toBe(`${CONVERSATION_ROOT}/.zcodium-share/report.md`);
    expect(unproven.markdown).toContain(
      `[report.md](${CONVERSATION_ROOT}/.zcodium-share/report.md)`,
    );
  });

  it("3. payload 树根是身份根、目标 composer 根是会话目录（树被重挂到身份根的反向场景）→ 用绝对路径", () => {
    const mention = createWorkspaceFileComposerMention(
      createPayload({
        fileReferenceRootPath: CONVERSATION_ROOT,
        path: `${CONVERSATION_ROOT}/.zcodium-share/report.md`,
        relativePath: ".zcodium-share/report.md",
        name: "report.md",
      }),
      CONVERSATION_ROOT,
      undefined,
      SESSION_A,
    );

    expect(mention.value).toBe(`${CONVERSATION_ROOT}/.zcodium-share/report.md`);
  });

  it("4a. payload 缺 fileReferenceRootPath（旧数据）且目标根 = 身份根 → 仍用相对路径", () => {
    const mention = createWorkspaceFileComposerMention(
      createLegacyPayload(),
      CONVERSATION_ROOT,
      undefined,
      CONVERSATION_ROOT,
    );

    expect(mention.value).toBe(".zcodium-share/report.md");
  });

  it("4b. payload 缺 fileReferenceRootPath（旧数据）且目标根 = 会话目录 → 用绝对路径", () => {
    const mention = createWorkspaceFileComposerMention(
      createLegacyPayload(),
      CONVERSATION_ROOT,
      undefined,
      SESSION_A,
    );

    expect(mention.value).toBe(`${CONVERSATION_ROOT}/.zcodium-share/report.md`);
  });

  it("4c. 目标侧 fileReferenceRootPath 缺席时按目标 workspacePath 归一化", () => {
    const projectPayload = createPayload({
      workspacePath: PROJECT_ROOT,
      fileReferenceRootPath: PROJECT_ROOT,
      path: `${PROJECT_ROOT}/src/app.ts`,
    });

    expect(createWorkspaceFileComposerMention(projectPayload, PROJECT_ROOT, undefined).value).toBe(
      "src/app.ts",
    );
    // 会话树拖给非会话 composer（解析根 = 身份根）：不同源。
    expect(
      createWorkspaceFileComposerMention(createPayload(), CONVERSATION_ROOT, undefined).value,
    ).toBe(`${SESSION_A}/src/app.ts`);
  });

  it("5. 工作区身份不同（workspacePath 不匹配）→ 用绝对路径（回归）", () => {
    const mention = createWorkspaceFileComposerMention(
      createPayload({
        workspacePath: PROJECT_ROOT,
        fileReferenceRootPath: PROJECT_ROOT,
        path: `${PROJECT_ROOT}/src/app.ts`,
      }),
      CONVERSATION_ROOT,
      undefined,
      SESSION_A,
    );

    expect(mention.value).toBe(`${PROJECT_ROOT}/src/app.ts`);
  });

  it("5b. workspacePath 相同但 workspaceIdentity 不同 → 用绝对路径（回归）", () => {
    const mention = createWorkspaceFileComposerMention(
      createPayload({ workspaceIdentity: "remote-1" }),
      CONVERSATION_ROOT,
      "remote-2",
      SESSION_A,
    );

    expect(mention.value).toBe(`${SESSION_A}/src/app.ts`);
    // 身份相同的对照：仍然走相对路径。
    expect(
      createWorkspaceFileComposerMention(
        createPayload({ workspaceIdentity: "remote-1" }),
        CONVERSATION_ROOT,
        "remote-1",
        SESSION_A,
      ).value,
    ).toBe("src/app.ts");
  });

  it("6a. Windows 分隔符与尾斜杠：areWorkspaceFilePathsEqual 归一化后相等 → 用相对路径", () => {
    const mention = createWorkspaceFileComposerMention(
      createPayload({
        workspacePath: "C:\\Users\\me\\ws\\default",
        fileReferenceRootPath: "C:\\Users\\me\\ws\\default\\2026-10-11\\a1b2c3d4",
        path: "C:\\Users\\me\\ws\\default\\2026-10-11\\a1b2c3d4\\src\\app.ts",
        relativePath: "src/app.ts",
      }),
      "C:\\Users\\me\\ws\\default",
      undefined,
      "C:/Users/me/ws/default/2026-10-11/a1b2c3d4/",
    );

    expect(mention.value).toBe("src/app.ts");
  });

  it("6b. 盘符大小写不在 areWorkspaceFilePathsEqual 的归一化范围内 → 判为不同源，用绝对路径", () => {
    // 该工具只做「反斜杠 → 正斜杠 + 去尾斜杠」，不做大小写折叠；实现复用它，因此这里保持一致。
    // 两侧路径都由同一个 React 状态产生，实际不会出现只有盘符大小写不同的情况。
    const mention = createWorkspaceFileComposerMention(
      createPayload({
        workspacePath: "C:\\Users\\me\\ws\\default",
        fileReferenceRootPath: "C:\\Users\\me\\ws\\default\\2026-10-11\\a1b2c3d4",
        path: "C:\\Users\\me\\ws\\default\\2026-10-11\\a1b2c3d4\\src\\app.ts",
        relativePath: "src/app.ts",
      }),
      "c:\\Users\\me\\ws\\default",
      undefined,
      "c:/Users/me/ws/default/2026-10-11/a1b2c3d4",
    );

    expect(mention.value).toBe("C:\\Users\\me\\ws\\default\\2026-10-11\\a1b2c3d4\\src\\app.ts");
  });
});

describe("readWorkspaceFileDragPayload 对 fileReferenceRootPath 的容错", () => {
  it("保留字符串值，且不影响其它字段", () => {
    const payload = createPayload();
    const parsed = readWorkspaceFileDragPayload({
      types: [WORKSPACE_FILE_DRAG_MIME],
      getData: () => serializeWorkspaceFileDragPayload(payload),
    } as unknown as DataTransfer);

    expect(parsed).toEqual(payload);
  });

  it("非字符串 / 空串 / 空白视为缺席（与 workspaceIdentity 同一处理风格）", () => {
    for (const value of [undefined, null, 42, {}, [], "", "   "]) {
      const parsed = readPayloadFromRaw({ ...createPayload(), fileReferenceRootPath: value });
      expect(parsed).not.toBeNull();
      expect(parsed && "fileReferenceRootPath" in parsed).toBe(false);
      // 缺席不影响其它字段解析。
      expect(parsed).toMatchObject({
        type: "file",
        workspacePath: CONVERSATION_ROOT,
        path: `${SESSION_A}/src/app.ts`,
        relativePath: "src/app.ts",
        name: "app.ts",
      });
    }
  });

  it("缺少该字段的旧 payload 仍可解析", () => {
    expect(readPayloadFromRaw(createLegacyPayload())).toEqual(createLegacyPayload());
  });
});

describe("appendWorkspaceFileMentionToComposer", () => {
  it("把解析根透传给同源判据，并写入编辑器句柄", () => {
    const appendFileMention = vi.fn();
    const focus = vi.fn();
    const onTextChange = vi.fn();

    const nextText = appendWorkspaceFileMentionToComposer({
      inputApiRef: { current: { appendFileMention, focus } } as never,
      currentMarkdown: "",
      payload: createPayload(),
      workspacePath: CONVERSATION_ROOT,
      fileReferenceRootPath: SESSION_B,
      onTextChange,
    });

    expect(nextText).toContain(`${SESSION_A}/src/app.ts`);
    expect(onTextChange).toHaveBeenCalledWith(nextText);
    expect(appendFileMention).toHaveBeenCalledWith(
      "app.ts",
      `${SESSION_A}/src/app.ts`,
      expect.stringContaining(`[app.ts](${SESSION_A}/src/app.ts)`),
      expect.objectContaining({
        path: `${SESSION_A}/src/app.ts`,
        relativePath: `${SESSION_A}/src/app.ts`,
      }),
    );
    expect(focus).toHaveBeenCalled();
  });
});

// A1 回归：草稿（未绑定）pane 的解析根必须是**预热会话目录**，不是身份根。
//
// 场景链：草稿期侧栏文件树仍按壳层的 `activeTaskId === null` 回落身份根（spec 已知边界 2，
// 有意保留），拖进来的 payload 因此是「身份根相对」的（`fileReferenceRootPath` = 身份根）。
// SessionPane 只按 `sessionId` 校验快照身份时，composer 的解析根也回落身份根 → 判为同源 →
// 插入相对路径；首发后 Agent 的 cwd 是会话目录，按它解析这些相对路径就找不到文件
// （改动前会话 cwd 恰好等于身份根，所以旧行为在草稿期才是对的）。
//
// 第七轮之后这一支还有第三种状态：**预热尚未就绪**（没有可用的会话快照）——两个根都回落
// 身份根，同源判据给出「可用」的假结论。现在解析根带来源（`resolved`），未被会话事实证明时
// 一律投绝对路径（本文件第三条用例即该修复的回归点）。
describe("草稿态 pane 的解析根（预热会话目录 vs 身份根）", () => {
  const PREWARM_SESSION_ID = "sess_prewarm";
  const PREWARM_DIR = `${CONVERSATION_ROOT}/2026-10-11/bbccddee`;

  /** SessionPane 的派生：草稿态快照属于预热会话，解析根 = 预热会话目录。 */
  function resolveDraftPaneRoot() {
    return resolvePaneFileSearchRoot({
      snapshot: { sessionId: PREWARM_SESSION_ID, workspacePath: PREWARM_DIR },
      sessionId: null,
      prewarmSessionId: PREWARM_SESSION_ID,
      tabWorkspacePath: CONVERSATION_ROOT,
    });
  }

  it("身份根相对 payload 拖进草稿 composer → 绝对路径（修复前是身份根相对路径）", () => {
    const paneRoot = resolveDraftPaneRoot();
    expect(paneRoot).toEqual({ resolved: true, rootPath: PREWARM_DIR });

    const mention = createWorkspaceFileComposerMention(
      createLegacyPayload(),
      CONVERSATION_ROOT,
      undefined,
      paneRoot.rootPath,
      { fileReferenceRootResolved: paneRoot.resolved },
    );

    // 不同源 → 投绝对路径，Agent 在会话目录里也能解析。
    expect(mention.value).toBe(`${CONVERSATION_ROOT}/.zcodium-share/report.md`);
    // 修复前的形态（composer 解析根也回落身份根 → 同源 → 相对路径），必须消失。
    const before = createWorkspaceFileComposerMention(
      createLegacyPayload(),
      CONVERSATION_ROOT,
      undefined,
      CONVERSATION_ROOT,
    );
    expect(before.value).toBe(".zcodium-share/report.md");
    expect(mention.value).not.toBe(before.value);
  });

  it("预热会话自己的树（同源）→ 仍用相对路径", () => {
    const paneRoot = resolveDraftPaneRoot();
    const mention = createWorkspaceFileComposerMention(
      createPayload({
        fileReferenceRootPath: PREWARM_DIR,
        path: `${PREWARM_DIR}/src/app.ts`,
        relativePath: "src/app.ts",
      }),
      CONVERSATION_ROOT,
      undefined,
      paneRoot.rootPath,
      { fileReferenceRootResolved: paneRoot.resolved },
    );

    expect(mention.value).toBe("src/app.ts");
    expect(mention.markdown).toContain("(./src/app.ts)");
  });

  it("预热尚未就绪（无可用会话快照）→ 根回落身份根但标记为未证明 ⇒ 投绝对路径", () => {
    const paneRoot = resolvePaneFileSearchRoot({
      snapshot: null,
      sessionId: null,
      prewarmSessionId: null,
      tabWorkspacePath: CONVERSATION_ROOT,
    });

    expect(paneRoot).toEqual({ resolved: false, rootPath: CONVERSATION_ROOT });
    // 这是第七轮实测出的豁口：两侧根相等 ⇒ 旧判据判同源 ⇒ 投身份根相对路径，而首发的
    // Agent cwd 是新铸的会话目录（本特性引入的收窄）。修复后必须投绝对路径。
    expect(
      createWorkspaceFileComposerMention(
        createLegacyPayload(),
        CONVERSATION_ROOT,
        undefined,
        paneRoot.rootPath,
        { fileReferenceRootResolved: paneRoot.resolved },
      ).value,
    ).toBe(`${CONVERSATION_ROOT}/.zcodium-share/report.md`);
  });

  it("项目/远端会话（快照无 workspacePath）→ 回落根**已被证明**，仍投相对路径（不回归）", () => {
    const paneRoot = resolvePaneFileSearchRoot({
      snapshot: { sessionId: "sess_project" },
      sessionId: "sess_project",
      prewarmSessionId: null,
      tabWorkspacePath: PROJECT_ROOT,
    });

    expect(paneRoot).toEqual({ resolved: true, rootPath: PROJECT_ROOT });
    expect(
      createWorkspaceFileComposerMention(
        createLegacyPayload({
          workspacePath: PROJECT_ROOT,
          path: `${PROJECT_ROOT}/report.md`,
          relativePath: "report.md",
        }),
        PROJECT_ROOT,
        undefined,
        paneRoot.rootPath,
        { fileReferenceRootResolved: paneRoot.resolved },
      ).value,
    ).toBe("report.md");
  });
});
