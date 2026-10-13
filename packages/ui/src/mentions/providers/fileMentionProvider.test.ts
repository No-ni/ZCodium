import { describe, expect, it } from "vitest";
import { mapWorkspaceFileToMentionItem } from "@/mentions/providers/fileMentionProvider.js";

// `@` / `+` 菜单的文件候选插入形态（见 docs/specs/conversation-session-workspace.md 规则 11、
// 已知边界 14）：候选的 `relativePath` 相对**搜索根**。搜索根是回落值（草稿预热未就绪 /
// 首帧身份不匹配）时接收这批内容的会话还没有自己的执行目录，相对路径会被首发会话按新铸的
// 会话目录解析而找不到文件——那时必须插入绝对路径。
const ENTRY = {
  name: "app.ts",
  path: "/Users/me/.zcodium/workspace/default/src/app.ts",
  relativePath: "src/app.ts",
  type: "file" as const,
};

describe("mapWorkspaceFileToMentionItem", () => {
  it("搜索根由会话事实证明 → 用相对路径（改动前行为）", () => {
    const item = mapWorkspaceFileToMentionItem(ENTRY, true);

    expect(item.value).toBe("src/app.ts");
    expect(item.markdown).toContain("(./src/app.ts)");
    expect(item.data?.relativePath).toBe("src/app.ts");
    // 绝对路径始终留在 data.path 里，供打开与回退使用。
    expect(item.data?.path).toBe(ENTRY.path);
    expect(item.description).toBe("src/app.ts");
  });

  it("搜索根是回落值 → 用绝对路径（首发会话按自己的 cwd 也能解析）", () => {
    const item = mapWorkspaceFileToMentionItem(ENTRY, false);

    expect(item.value).toBe(ENTRY.path);
    expect(item.markdown).toContain(`[app.ts](${ENTRY.path})`);
    expect(item.data?.relativePath).toBe(ENTRY.path);
    expect(item.data?.path).toBe(ENTRY.path);
  });
});
