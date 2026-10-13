import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSystemPortError, type FileSystemPort } from "@zcode/contracts";
import { readApprovedPlanFileReferenceEntry } from "./plan-file-continuity.js";

const CONVERSATION_ROOT = "/Users/me/.zcodium/workspace/default";
const SESSION_DIR = `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4`;
const SESSION_ID = "sess_11111111-2222-3333-4444-555555555555";
const PLAN_FILE_NAME = `plan-${SESSION_ID}.md`;

function planFilePath(root: string): string {
  return join(root, ".zcodium", "plans", PLAN_FILE_NAME);
}

/**
 * 记录读取顺序的假端口：只有明确给出的路径存在，其余报 `not_found`（与真实端口一致的错误码）。
 */
function createPlanFilePort(files: Record<string, string>): {
  port: FileSystemPort;
  readPaths: string[];
} {
  const readPaths: string[] = [];
  const port = {
    async readTextFile(params: { path: string }) {
      readPaths.push(params.path);
      const content = files[params.path];
      if (content === undefined) {
        throw new FileSystemPortError({
          code: "not_found",
          message: `not found: ${params.path}`,
          path: params.path,
        });
      }
      return { content };
    },
  } as unknown as FileSystemPort;
  return { port, readPaths };
}

// 计划文件的落点随执行 cwd（本特性的规则：会话产物跟着会话目录走），但**升级前**写下的计划文件
// 住在工作区键路径下。压缩后的「计划仍在进行」提醒只按执行 cwd 找，会让这些老计划静默消失
// （文件从未被删）。读取顺序因此是「执行 cwd 优先、工作区键路径兜底」，且同一个根不读两次。
// 见 docs/specs/conversation-session-workspace.md 已知边界 25。
describe("readApprovedPlanFileReferenceEntry 的计划文件读取根", () => {
  it("执行 cwd 命中时只读它，老落点即使有文件也不看（本会话当前事实优先）", async () => {
    const { port, readPaths } = createPlanFilePort({
      [planFilePath(SESSION_DIR)]: "新计划：按会话目录落盘",
      [planFilePath(CONVERSATION_ROOT)]: "老计划：按对话根落盘",
    });

    const entry = await readApprovedPlanFileReferenceEntry({
      fileSystemPort: port,
      sessionId: SESSION_ID,
      workspaceKeyRoot: CONVERSATION_ROOT,
      workspaceRoot: SESSION_DIR,
    });

    expect(readPaths).toEqual([planFilePath(SESSION_DIR)]);
    expect(JSON.stringify(entry)).toContain("新计划");
    expect(JSON.stringify(entry)).not.toContain("老计划");
  });

  it("执行 cwd 未命中时回退工作区键路径：存量会话的老计划仍能被提醒", async () => {
    const { port, readPaths } = createPlanFilePort({
      [planFilePath(CONVERSATION_ROOT)]: "老计划：按对话根落盘",
    });

    const entry = await readApprovedPlanFileReferenceEntry({
      fileSystemPort: port,
      sessionId: SESSION_ID,
      workspaceKeyRoot: CONVERSATION_ROOT,
      workspaceRoot: SESSION_DIR,
    });

    expect(readPaths).toEqual([planFilePath(SESSION_DIR), planFilePath(CONVERSATION_ROOT)]);
    // 提醒里的路径必须是真正读到内容的那一个：模型据此继续编辑计划文件。
    expect(JSON.stringify(entry)).toContain(planFilePath(CONVERSATION_ROOT));
    expect(JSON.stringify(entry)).toContain("老计划");
  });

  it("两个根相同（CLI/TUI 独立运行、项目工作区）时只读一次，不产生多余 IO", async () => {
    const { port, readPaths } = createPlanFilePort({
      [planFilePath(SESSION_DIR)]: "计划",
    });

    const entry = await readApprovedPlanFileReferenceEntry({
      fileSystemPort: port,
      sessionId: SESSION_ID,
      workspaceKeyRoot: `  ${SESSION_DIR}  `,
      workspaceRoot: SESSION_DIR,
    });

    expect(readPaths).toEqual([planFilePath(SESSION_DIR)]);
    expect(entry).toBeDefined();
  });

  it("两个根都没有计划文件时返回 undefined（压缩不因此失败），最多读两次", async () => {
    const { port, readPaths } = createPlanFilePort({});

    const entry = await readApprovedPlanFileReferenceEntry({
      fileSystemPort: port,
      sessionId: SESSION_ID,
      workspaceKeyRoot: CONVERSATION_ROOT,
      workspaceRoot: SESSION_DIR,
    });

    expect(entry).toBeUndefined();
    expect(readPaths).toHaveLength(2);
  });

  it("非 not_found 的读取错误照旧向上冒泡（不回退、不吞错）", async () => {
    const port = {
      async readTextFile() {
        throw new FileSystemPortError({ code: "permission_denied", message: "denied" });
      },
    } as unknown as FileSystemPort;

    await expect(
      readApprovedPlanFileReferenceEntry({
        fileSystemPort: port,
        sessionId: SESSION_ID,
        workspaceKeyRoot: CONVERSATION_ROOT,
        workspaceRoot: SESSION_DIR,
      }),
    ).rejects.toThrow("denied");
  });
});
