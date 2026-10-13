import { describe, expect, it } from "vitest";
import { parseWorkspaceCheckpointArtifact } from "../deps.js";
import {
  resolveWorkspaceCheckpointRoot,
  stringifyWorkspaceCheckpointArtifact,
} from "./rewind.js";

const CONVERSATION_ROOT = "/Users/me/.zcodium/workspace/default";
const SESSION_DIR = `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4`;
const PROJECT_DIR = "/Users/me/Projects/demo";

// checkpoint 的 `files[].path` 是模型原文（写/编辑工具回填 `file_path`），相对路径只有在
// 「创建它时的 cwd」下才有意义。本特性把对话会话的执行 cwd 从工作区键路径改成了会话目录，
// 存量会话补发后两者不再相等，于是老 checkpoint 的相对路径必须按**当时的** cwd（= 工作区键
// 路径）解析，否则整次「编辑并重试 + 回滚工作区」会被误判成「文件已被外部修改」而阻断。
// 见 docs/specs/conversation-session-workspace.md 已知边界 24。
describe("resolveWorkspaceCheckpointRoot", () => {
  it("artifact 记录了创建时的 cwd → 用它（执行 cwd 后来变化也不影响）", () => {
    expect(
      resolveWorkspaceCheckpointRoot({
        executionRoot: SESSION_DIR,
        recordedRoot: SESSION_DIR,
        workspaceKeyRoot: CONVERSATION_ROOT,
      }),
    ).toBe(SESSION_DIR);
  });

  it("老 checkpoint（没有记录 cwd）→ 用工作区键路径，即它们当时的 cwd", () => {
    expect(
      resolveWorkspaceCheckpointRoot({
        executionRoot: SESSION_DIR,
        workspaceKeyRoot: CONVERSATION_ROOT,
      }),
    ).toBe(CONVERSATION_ROOT);
  });

  it("没有工作区键路径（CLI/TUI 独立运行）→ 回落本次执行 cwd，与改动前逐位一致", () => {
    expect(
      resolveWorkspaceCheckpointRoot({
        executionRoot: PROJECT_DIR,
        workspaceKeyRoot: undefined,
      }),
    ).toBe(PROJECT_DIR);
  });

  it("空白值一律按缺席处理，不产生 `resolve(\"\")` 这种漂到进程 cwd 的根", () => {
    expect(
      resolveWorkspaceCheckpointRoot({
        executionRoot: PROJECT_DIR,
        recordedRoot: "   ",
        workspaceKeyRoot: "  ",
      }),
    ).toBe(PROJECT_DIR);
  });
});

describe("stringifyWorkspaceCheckpointArtifact", () => {
  const candidate = {
    filePath: "docs/report.md",
    originalFile: "old",
    structuredPatch: [],
  };
  const result = { toolCallId: "call_1", toolName: "Write" } as never;

  it("把创建时的执行 cwd 写进 artifact，并能被合同 schema 原样读回", () => {
    const parsed = parseWorkspaceCheckpointArtifact(
      JSON.parse(stringifyWorkspaceCheckpointArtifact(candidate, result, SESSION_DIR)),
    );
    expect(parsed.workspaceRoot).toBe(SESSION_DIR);
    // 模型原文不改写：解析仍是 rewind 一侧的职责。
    expect(parsed.files[0]?.path).toBe("docs/report.md");
  });

  it("没有执行 cwd 时省略该字段（schema 允许缺席，老 artifact 因此仍可解析）", () => {
    const parsed = parseWorkspaceCheckpointArtifact(
      JSON.parse(stringifyWorkspaceCheckpointArtifact(candidate, result)),
    );
    expect(parsed.workspaceRoot).toBeUndefined();
    expect(
      resolveWorkspaceCheckpointRoot({
        executionRoot: CONVERSATION_ROOT,
        recordedRoot: parsed.workspaceRoot,
        workspaceKeyRoot: CONVERSATION_ROOT,
      }),
    ).toBe(CONVERSATION_ROOT);
  });
});
