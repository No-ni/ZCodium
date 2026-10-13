import { describe, expect, it } from "vitest";
import { resolveRecentChangeDisplayPath } from "./recentChangeDisplayPath.js";

// Cmd+P「最近改动」行的展示基准（见 docs/specs/conversation-session-workspace.md 规则 12）。
//
// 展示取「最深包含根」：会话执行 cwd 命中优先，回落工作区身份根。只按搜索根换算时，
// 落在对话根（身份根）内、会话目录外的文件（`.zcodium/skills/...`）会显示成绝对全路径——
// 与文件变更摘要面板的展示不一致（回归点）。

const CONVERSATION_ROOT = "/Users/me/.zcodium/workspace/default";
const SESSION_DIR = `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4`;

describe("resolveRecentChangeDisplayPath", () => {
  it("文件在会话目录内 → 相对会话目录（不出现 `日期/id8/` 前缀）", () => {
    const displayPath = resolveRecentChangeDisplayPath({
      filePath: `${SESSION_DIR}/src/report.md`,
      fileSearchRootPath: SESSION_DIR,
      workspaceAbsPath: CONVERSATION_ROOT,
    });

    expect(displayPath).toBe("src/report.md");
    expect(displayPath).not.toContain("2026-10-11/a1b2c3d4");
  });

  it("文件在身份根内但在会话目录外 → 相对身份根（回归：旧实现给绝对全路径）", () => {
    const filePath = `${CONVERSATION_ROOT}/.zcodium/skills/demo/SKILL.md`;
    const displayPath = resolveRecentChangeDisplayPath({
      filePath,
      fileSearchRootPath: SESSION_DIR,
      workspaceAbsPath: CONVERSATION_ROOT,
    });

    expect(displayPath).toBe(".zcodium/skills/demo/SKILL.md");
    // 旧基准（只按搜索根剥前缀）的产物，必须消失：它落在搜索根之外，原样返回绝对路径。
    expect(displayPath).not.toBe(filePath);
  });

  it("两个根都不包含（工作区外的绝对路径）→ 仍显示绝对路径 = 改动前行为", () => {
    const filePath = "/tmp/other/outside.md";
    expect(
      resolveRecentChangeDisplayPath({
        filePath,
        fileSearchRootPath: SESSION_DIR,
        workspaceAbsPath: CONVERSATION_ROOT,
      }),
    ).toBe(filePath);
  });

  it("会话搜索根缺席（草稿 / 旧 CLI / 非对话会话）→ 相对身份根 = 改动前行为", () => {
    expect(
      resolveRecentChangeDisplayPath({
        filePath: `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4/src/report.md`,
        workspaceAbsPath: CONVERSATION_ROOT,
      }),
    ).toBe("2026-10-11/a1b2c3d4/src/report.md");
    expect(
      resolveRecentChangeDisplayPath({
        filePath: `${CONVERSATION_ROOT}/.zcodium/skills/demo/SKILL.md`,
        fileSearchRootPath: undefined,
        workspaceAbsPath: CONVERSATION_ROOT,
      }),
    ).toBe(".zcodium/skills/demo/SKILL.md");
  });

  it("会话搜索根等于身份根（项目工作区 / 未启用独立目录）→ 与改动前逐字相同", () => {
    const filePath = `${CONVERSATION_ROOT}/src/report.md`;
    expect(
      resolveRecentChangeDisplayPath({
        filePath,
        fileSearchRootPath: CONVERSATION_ROOT,
        workspaceAbsPath: CONVERSATION_ROOT,
      }),
    ).toBe("src/report.md");
  });

  it("模型写的相对路径原文 → 不含任何根，按身份根原样展示（读取基准另算）", () => {
    expect(
      resolveRecentChangeDisplayPath({
        filePath: "src/report.md",
        fileSearchRootPath: SESSION_DIR,
        workspaceAbsPath: CONVERSATION_ROOT,
      }),
    ).toBe("src/report.md");
  });

  it("Windows 反斜杠形态沿用既有归一化（剥前缀只用于比较）", () => {
    const windowsRoot = "C:\\Users\\me\\ws\\default";
    const windowsSession = `${windowsRoot}\\2026-10-11\\a1b2c3d4`;
    expect(
      resolveRecentChangeDisplayPath({
        filePath: `${windowsSession}\\src\\report.md`,
        fileSearchRootPath: windowsSession,
        workspaceAbsPath: windowsRoot,
      }),
    ).toBe("src/report.md");
    expect(
      resolveRecentChangeDisplayPath({
        filePath: `${windowsRoot}\\.zcodium\\skills\\demo\\SKILL.md`,
        fileSearchRootPath: windowsSession,
        workspaceAbsPath: windowsRoot,
      }),
    ).toBe(".zcodium/skills/demo/SKILL.md");
  });
});
