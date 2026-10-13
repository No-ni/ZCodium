import { describe, expect, it } from "vitest";
import { buildMessageFileLinkTarget } from "@/components/ai-elements/message.js";

// 消息正文文件链接的「复制相对路径」基准（第十一轮修）。
//
// `relativePath` 的唯一消费方是 useFileContextActions 的 copyRelativePath。基准必须是
// **最深包含根**（resolveFileDisplayBasePath）：会话目录内的文件按会话执行 cwd 剥前缀；
// 会话目录之外、对话根之内的文件（`.zcodium-share/`、`.zcodium/skills/`、plans——这些正是
// 本特性的常驻位置）回落身份根。只按执行 cwd 一个基准算时，getWorkspaceFileRelativePath
// 对根外文件退化成裸文件名（剪贴板回归，改动前基准恒为身份根、能得到带目录的相对路径）。

const CONVERSATION_ROOT = "/Users/me/.zcodium/workspace/default";
const SESSION_DIR = `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4`;

function build(
  path: string,
  overrides?: { workspacePath?: string; fileReferenceRootPath?: string },
) {
  return buildMessageFileLinkTarget({
    href: path,
    label: "SKILL.md",
    path,
    workspacePath: overrides?.workspacePath ?? CONVERSATION_ROOT,
    ...(overrides?.fileReferenceRootPath === undefined
      ? {}
      : { fileReferenceRootPath: overrides.fileReferenceRootPath }),
  });
}

describe("buildMessageFileLinkTarget：复制相对路径按最深包含根", () => {
  it("会话目录内的文件按会话执行 cwd 剥前缀", () => {
    const target = build(`${SESSION_DIR}/src/foo.ts`, { fileReferenceRootPath: SESSION_DIR });
    expect(target.relativePath).toBe("src/foo.ts");
  });

  it("会话目录外、对话根内的文件回落身份根，不再退化成裸文件名", () => {
    const skillPath = `${CONVERSATION_ROOT}/.zcodium/skills/demo/SKILL.md`;
    const target = build(skillPath, { fileReferenceRootPath: SESSION_DIR });
    expect(target.relativePath).toBe(".zcodium/skills/demo/SKILL.md");
  });

  it("没有会话根（旧发送端）时按身份根，与改动前一致", () => {
    const skillPath = `${CONVERSATION_ROOT}/.zcodium/plans/demo/plan.md`;
    const target = build(skillPath);
    expect(target.relativePath).toBe(".zcodium/plans/demo/plan.md");
  });

  it("两个根都缺席时保留旧回落（label）", () => {
    const target = buildMessageFileLinkTarget({
      href: "/tmp/x/SKILL.md",
      label: "SKILL.md",
      path: "/tmp/x/SKILL.md",
      workspacePath: undefined,
    });
    expect(target.relativePath).toBe("SKILL.md");
  });
});
