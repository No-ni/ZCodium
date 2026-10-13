import { describe, expect, it } from "vitest";
import { buildAssistantCodeCommentCards } from "./assistantCodeComment.js";
import {
  buildAssistantPreviewCardsFromReferences,
  extractAssistantFileReferences,
} from "./assistantPreviewCards.js";

// 对话正文里的**相对**文件路径基准 = 模型写路径时的 cwd = 会话执行 cwd
// （`<对话根>/<创建日>/<会话id前8位>`），不是 tab 的工作区键路径（对话根）。
// 两者在改动前恰好相同，所以只有对话会话暴露：用对话根当基准会让相对引用解析到
// 对话根上不存在的路径，卡片因文件不存在被静默过滤，代码注释卡片打开时指向错文件。
// 见 docs/specs/conversation-session-workspace.md 规则 9（工作区级读点 vs 执行 cwd）。

const CONVERSATION_ROOT = "/Users/me/.zcodium/workspace/default";
const SESSION_DIR = `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4`;

describe("assistant 预览卡片的相对路径基准", () => {
  it("目录限定的相对 md 引用按会话执行 cwd 解析，并与本轮文件变更对上", () => {
    const content = "已生成 [报告](docs/report.md)。";
    const references = extractAssistantFileReferences(content, SESSION_DIR);
    const cards = buildAssistantPreviewCardsFromReferences(content, SESSION_DIR, references, {
      changedFilePaths: [`${SESSION_DIR}/docs/report.md`],
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ type: "markdown", path: `${SESSION_DIR}/docs/report.md` });
  });

  it("用工作区键路径当基准时该引用对不上本轮变更（回归面）", () => {
    const content = "已生成 [报告](docs/report.md)。";
    const references = extractAssistantFileReferences(content, CONVERSATION_ROOT);
    const cards = buildAssistantPreviewCardsFromReferences(content, CONVERSATION_ROOT, references, {
      changedFilePaths: [`${SESSION_DIR}/docs/report.md`],
    });

    expect(cards).toEqual([]);
  });

  it("相对 Office/PDF 引用解析到会话执行 cwd 下的文件", () => {
    const content = "见 report.pdf。";
    const references = extractAssistantFileReferences(content, SESSION_DIR);
    const cards = buildAssistantPreviewCardsFromReferences(content, SESSION_DIR, references, {
      changedFilePaths: [],
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      type: "file",
      kind: "pdf",
      path: `${SESSION_DIR}/report.pdf`,
    });
  });
});

describe("代码注释卡片的两根分工", () => {
  // code-comment 协议默认要求双冒号（`extractAssistantDirectives` 的 `:{2,2}` 前缀）。
  const comment = (file: string) => `::code-comment{title="问题" body="正文" file="${file}"}`;

  it("相对 file 按会话执行 cwd 解析，展示仍用模型写的形式", () => {
    const cards = buildAssistantCodeCommentCards(comment("src/foo.ts"), SESSION_DIR, 50, {
      displayRootPath: CONVERSATION_ROOT,
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]?.path).toBe(`${SESSION_DIR}/src/foo.ts`);
    expect(cards[0]?.displayPath).toBe("src/foo.ts");
  });

  it("引用工作区根上的文件（解析基准之外）不丢卡片，展示回落工作区根相对", () => {
    const cards = buildAssistantCodeCommentCards(
      comment(`${CONVERSATION_ROOT}/.zcodium/skills/demo/SKILL.md`),
      SESSION_DIR,
      50,
      { displayRootPath: CONVERSATION_ROOT },
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.path).toBe(`${CONVERSATION_ROOT}/.zcodium/skills/demo/SKILL.md`);
    expect(cards[0]?.displayPath).toBe(".zcodium/skills/demo/SKILL.md");
  });
});
