import { describe, expect, it } from "vitest";
import { resolveToolCallFilePath } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { getFileDisplayPath, resolveFileDisplayBasePath } from "./fileDisplay.js";

// 工具卡子树（ToolCallBlocks / 文件变更摘要面板）的**展示基准根**解析。
//
// 两分法（见 docs/specs/conversation-session-workspace.md 已知边界 12）：
// - `workspacePath` = 工作区身份根（对话根 `~/.zcodium/workspace/default`），
//   code viewer 作用域 / 插件 scope / 文件树 workspaceScopePath 都读它；
// - 会话执行 cwd = `<对话根>/<YYYY-MM-DD>/<会话id前8位>`，是**模型写相对路径时的 cwd**，
//   也是展示与链接解析的基准。
// 展示基准取「最深包含根」：会话目录命中就用会话目录，否则回落身份根——
// 后者保持改动前行为，工作区外的绝对路径不会突然变成全路径。

const CONVERSATION_ROOT = "/Users/me/.zcodium/workspace/default";
const SESSION_DIR = `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4`;

describe("resolveFileDisplayBasePath：最深包含根", () => {
  it("路径在会话执行目录内 → 基准是会话目录（展示为 src/foo.ts）", () => {
    const filePath = `${SESSION_DIR}/src/foo.ts`;
    const basePath = resolveFileDisplayBasePath(filePath, [SESSION_DIR, CONVERSATION_ROOT]);

    expect(basePath).toBe(SESSION_DIR);
    // 展示组合：chip 标题/次路径不再带 `2026-10-11/a1b2c3d4/` 前缀。
    expect(getFileDisplayPath(filePath, basePath)).toBe("src/foo.ts");
    expect(getFileDisplayPath(filePath, basePath)).not.toBe("2026-10-11/a1b2c3d4/src/foo.ts");
  });

  it("路径在身份根内但不在会话目录内 → 基准回落身份根（与旧行为一致）", () => {
    const filePath = `${CONVERSATION_ROOT}/.zcodium/skills/demo/SKILL.md`;

    expect(resolveFileDisplayBasePath(filePath, [SESSION_DIR, CONVERSATION_ROOT])).toBe(
      CONVERSATION_ROOT,
    );
    expect(getFileDisplayPath(filePath, CONVERSATION_ROOT)).toBe(".zcodium/skills/demo/SKILL.md");
  });

  it("两个根都不包含 → 返回最后一个已定义的根（工作区外绝对路径不变全路径以外的东西）", () => {
    const filePath = "/tmp/other/outside.ts";

    expect(resolveFileDisplayBasePath(filePath, [SESSION_DIR, CONVERSATION_ROOT])).toBe(
      CONVERSATION_ROOT,
    );
    // stripBasePath 剥不掉 → 仍是原来的绝对路径（改动前同样是绝对路径）。
    expect(getFileDisplayPath(filePath, CONVERSATION_ROOT)).toBe(filePath);
  });

  it("第一个根为 undefined → 使用第二个根（旧 CLI 缺席会话 cwd 的回落）", () => {
    const filePath = `${CONVERSATION_ROOT}/src/foo.ts`;

    expect(resolveFileDisplayBasePath(filePath, [undefined, CONVERSATION_ROOT])).toBe(
      CONVERSATION_ROOT,
    );
    expect(getFileDisplayPath(filePath, CONVERSATION_ROOT)).toBe("src/foo.ts");
  });

  it("会话根与身份根都命中时取第一个（调用方按深→浅传参）", () => {
    const filePath = `${SESSION_DIR}/src/foo.ts`;
    // 顺序即优先级：调用方必须传 [会话执行 cwd, 身份根]。
    expect(resolveFileDisplayBasePath(filePath, [SESSION_DIR, CONVERSATION_ROOT])).toBe(
      SESSION_DIR,
    );
    expect(resolveFileDisplayBasePath(filePath, [CONVERSATION_ROOT, SESSION_DIR])).toBe(
      CONVERSATION_ROOT,
    );
  });

  it("空 roots / 全 undefined / 空字符串 → undefined（等于不剥前缀）", () => {
    expect(resolveFileDisplayBasePath(`${SESSION_DIR}/src/foo.ts`, [])).toBeUndefined();
    expect(
      resolveFileDisplayBasePath(`${SESSION_DIR}/src/foo.ts`, [undefined, undefined]),
    ).toBeUndefined();
    expect(resolveFileDisplayBasePath(`${SESSION_DIR}/src/foo.ts`, ["", "   "])).toBeUndefined();
  });

  it("相等路径算包含（文件恰好等于基准根）", () => {
    expect(resolveFileDisplayBasePath(SESSION_DIR, [SESSION_DIR, CONVERSATION_ROOT])).toBe(
      SESSION_DIR,
    );
    // 尾分隔符不影响判定。
    expect(resolveFileDisplayBasePath(`${SESSION_DIR}/`, [SESSION_DIR, CONVERSATION_ROOT])).toBe(
      SESSION_DIR,
    );
  });

  it("前缀相同但不是子路径的兄弟目录不算包含", () => {
    // `/a/bc` 不是 `/a/b` 的子路径（词法判定必须比对分隔符边界）。
    const sibling = `${CONVERSATION_ROOT}/2026-10-11/a1b2c3d4-extra/src/foo.ts`;

    expect(resolveFileDisplayBasePath(sibling, [SESSION_DIR, CONVERSATION_ROOT])).toBe(
      CONVERSATION_ROOT,
    );
  });

  it("Windows 反斜杠路径与大小写差异按规范化后的形态判定", () => {
    const windowsRoot = "C:\\Users\\me\\proj";
    const windowsSession = `${windowsRoot}\\2026-10-11\\a1b2c3d4`;

    // 反斜杠形态：直接命中会话目录。
    expect(
      resolveFileDisplayBasePath(`${windowsSession}\\src\\foo.ts`, [windowsSession, windowsRoot]),
    ).toBe(windowsSession);

    // 大小写差异（Windows 上同一路径可能来自不同来源）：只影响"选哪个根"，
    // 返回的仍是入参原值。
    expect(
      resolveFileDisplayBasePath("c:\\users\\me\\proj\\2026-10-11\\A1B2C3D4\\src\\foo.ts", [
        windowsSession,
        windowsRoot,
      ]),
    ).toBe(windowsSession);

    // 而且**必须剥得掉**：选根是大小写不敏感的，剥前缀若严格敏感就会显示成绝对全路径
    // （比改动前更差 —— 改动前基准恒为身份根，这里本来能显示相对串）。
    expect(
      getFileDisplayPath("c:\\users\\me\\proj\\2026-10-11\\A1B2C3D4\\src\\foo.ts", windowsSession),
    ).toBe("src/foo.ts");
    // 剥前缀的降级匹配只用于比较，返回值仍用原串切片（大小写保持来源形态）。
    expect(getFileDisplayPath(`${windowsSession.toUpperCase()}/SRC/FOO.TS`, windowsSession)).toBe(
      "SRC/FOO.TS",
    );

    // 分隔符规范化同样作用于展示：反斜杠基准能剥掉正/反斜杠混写的路径。
    expect(getFileDisplayPath(`${windowsSession}/src/foo.ts`, `${windowsSession}\\`)).toBe(
      "src/foo.ts",
    );
  });
});

describe("工具卡 chip 展示组合（回归：旧显示不得再出现）", () => {
  const sessionFile = `${SESSION_DIR}/src/foo.ts`;
  const rootFile = `${CONVERSATION_ROOT}/.zcodium/skills/demo/SKILL.md`;

  it("会话目录内的文件按会话目录展示，不出现 `2026-10-11/a1b2c3d4/` 前缀", () => {
    const displayPath = getFileDisplayPath(
      sessionFile,
      resolveFileDisplayBasePath(sessionFile, [SESSION_DIR, CONVERSATION_ROOT]),
    );

    expect(displayPath).toBe("src/foo.ts");
    // 旧实现（基准恒为身份根）的产物，必须消失。
    expect(displayPath).not.toContain("2026-10-11/a1b2c3d4");
    expect(getFileDisplayPath(sessionFile, CONVERSATION_ROOT)).toBe(
      "2026-10-11/a1b2c3d4/src/foo.ts",
    );
  });

  it("身份根上的文件仍按身份根展示（工作区级文件的旧行为不回退）", () => {
    const displayPath = getFileDisplayPath(
      rootFile,
      resolveFileDisplayBasePath(rootFile, [SESSION_DIR, CONVERSATION_ROOT]),
    );

    expect(displayPath).toBe(".zcodium/skills/demo/SKILL.md");
  });

  it("会话 cwd 缺席（旧 CLI / 非对话会话）→ 与改动前逐字相同", () => {
    const displayPath = getFileDisplayPath(
      sessionFile,
      resolveFileDisplayBasePath(sessionFile, [undefined, CONVERSATION_ROOT]),
    );

    expect(displayPath).toBe("2026-10-11/a1b2c3d4/src/foo.ts");
  });
});

// 工具卡子树里「真去读文件」的路径（code viewer / 预览读取）与展示基准是**两件事**：
// 工具输出里的路径是模型写的原文（CLI handler 把原始输入回填进结果），可能是相对路径，
// 读它必须按模型 cwd 解析；展示基准则取「最深包含根」。相对路径没有任何展示根"包含"它，
// 所以两处不能用同一个派生值。
describe("resolveToolCallFilePath：读取按模型 cwd 解析", () => {
  it("相对路径 → 拼上会话执行 cwd", () => {
    expect(resolveToolCallFilePath("src/foo.ts", SESSION_DIR)).toBe(`${SESSION_DIR}/src/foo.ts`);
    expect(resolveToolCallFilePath("docs/report.md", SESSION_DIR)).toBe(
      `${SESSION_DIR}/docs/report.md`,
    );
  });

  it("`.` / `..` 形态沿用 joinFilePath 的既有拼接行为（不做归一化）", () => {
    expect(resolveToolCallFilePath("./src/foo.ts", SESSION_DIR)).toBe(
      `${SESSION_DIR}/./src/foo.ts`,
    );
    expect(resolveToolCallFilePath("../other/foo.ts", SESSION_DIR)).toBe(
      `${SESSION_DIR}/../other/foo.ts`,
    );
  });

  it("绝对路径原样返回：POSIX / Windows 盘符 / UNC 都不重复拼接", () => {
    expect(resolveToolCallFilePath("/abs/foo.ts", SESSION_DIR)).toBe("/abs/foo.ts");
    expect(resolveToolCallFilePath("C:\\proj\\src\\foo.ts", SESSION_DIR)).toBe(
      "C:\\proj\\src\\foo.ts",
    );
    expect(resolveToolCallFilePath("\\\\server\\share\\foo.ts", SESSION_DIR)).toBe(
      "\\\\server\\share\\foo.ts",
    );
  });

  it("Windows 基准根沿用反斜杠分隔符", () => {
    expect(resolveToolCallFilePath("src\\foo.ts", "C:\\proj\\sess")).toBe(
      "C:\\proj\\sess\\src\\foo.ts",
    );
  });

  it("根缺失 → 原样返回（旧行为）", () => {
    expect(resolveToolCallFilePath("src/foo.ts", undefined)).toBe("src/foo.ts");
    expect(resolveToolCallFilePath("src/foo.ts", "")).toBe("src/foo.ts");
  });

  it("空路径原样返回（不为它编出一个目录）", () => {
    expect(resolveToolCallFilePath("", SESSION_DIR)).toBe("");
  });
});
