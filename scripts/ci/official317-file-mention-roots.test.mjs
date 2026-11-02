import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// 官方 3.17 合并冲突解决漏接线的回归网（docs/specs/conversation-session-workspace.md 规则 10/11、
// 已知边界 14）。合并把两套实现拼进同一个文件：官方的「多 root 文件搜索」（会话/项目的
// additionalDirectories）与本仓的「会话执行 cwd 解析根」（FileReferenceRoot + ignoreRulesRoot）。
// 冲突解决时后者被整段丢掉，只留下签名，结果是四类回归：
//   - searchRoot 未解构 ⇒ workspacePath / searchRootResolved 未声明，包编译不过；
//   - mapper 第二参缺失且不再 export ⇒ 调用方传两个实参对一个形参，候选全按相对路径插入；
//   - ignoreRulesRoot 既不进 searchWorkspaceFiles 也不进依赖数组 ⇒ 规则根回落 rootPath，
//     去会话目录找 `.zcodiumignore`（规则 10），且规则根变化后既不重发查询也沿用旧候选；
//   - projectService 取自已退休的 accessor 面。
//
// mapper 的纯函数行为（resolved true/false 两种插入形态）由
// packages/ui/src/mentions/providers/fileMentionProvider.test.ts 导入**生产代码**覆盖；
// 本文件补它看不见的部分：hook 的根集合构成、身份解析取哪个根、每根请求带什么、取消门禁。
// 每条契约都写在「为什么必须是这个根」上；改实现前先改这里的理由，不要只改字符串。
const PROVIDER = "packages/ui/src/mentions/providers/fileMentionProvider.ts";

/** 换行/缩进不影响判据：压成单空格后做子串匹配（与 wiring 测试同一约定）。 */
function normalize(text) {
  return text.replace(/\s+/gu, " ").trim();
}

/** 取锚点之后第一个数组字面量的元素（依赖数组契约用）。 */
function depsAfter(text, marker) {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `缺少锚点：${marker}`);
  const open = text.indexOf("[", at + marker.length);
  assert.ok(open >= 0, `锚点后没有数组字面量：${marker}`);
  const close = text.indexOf("]", open);
  assert.ok(close >= 0, `数组字面量未闭合：${marker}`);
  return text
    .slice(open + 1, close)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const CONTRACTS = [
  [
    "export function mapWorkspaceFileToMentionItem( entry: ProjectFileEntry, rootResolved: boolean, ): MentionItem",
    "mapper 必须导出且带来源事实第二参：不导出时生产测试的 import 直接红，第二参丢了就退化成一律相对路径",
  ],
  [
    "const mentionPath = rootResolved ? (entry.mentionPath ?? entry.relativePath) : entry.path;",
    "未证明的搜索根（草稿预热未就绪 / 首帧身份不匹配）⇒ 主根候选也投绝对路径，否则首发会话按自己新铸的 cwd 解析找不到文件；额外 root 的 mentionPath 本身就是绝对路径，两条路都封死",
  ],
  [
    "relativePath: mentionPath,",
    "data.relativePath 与 value/markdown 同源：序列化层按它重建链接目标，这里留相对路径会让 chip→markdown 往返后又变回找不到的引用",
  ],
  [
    "result.entries.map((entry) => mapWorkspaceFileToMentionItem(entry, searchRootResolved))",
    "候选映射必须把来源事实传给 mapper：漏传时未证明的根仍插相对路径",
  ],
  [
    "useWorkspaceServicesResolution( ignoreRulesRoot, undefined, workspaceIdentity, )",
    "连接与身份解析按 tab 的 workspacePath 走：searchRoot.rootPath 可能只是某个会话的执行 cwd，拿它解析服务等于把会话目录当成 workspace 身份",
  ],
  [
    "const projectService = services.windowProjectDirectory?.projectService;",
    "项目服务只经 windowProjectDirectory 面取；accessor 上的同名面已退休，旧 Host / 测试 double 可不提供并由 readRoots 显式报不可用",
  ],
  [
    "workspacePath: ignoreRulesRoot,",
    "任务归属按工作区身份根查：库里的 task 行以对话根为 workspacePath，按会话执行 cwd 查不到任何项目绑定，additionalDirectories 会空",
  ],
  [
    "const roots = [...new Set([searchRootPath, ...(await readRoots())])];",
    "主根是本次文件搜索根（会话执行 cwd），额外目录拼在其后：单 session 就是固定 cwd + additionalDirectories",
  ],
  [
    "searchWorkspaceFiles({ rootPath, ignoreRulesRoot, workspaceIdentity, query, limit,",
    "每个 root 的搜索请求都带 ignoreRulesRoot：规则只有一份、落在对话根上，会话目录里不生成 `.zcodiumignore`（规则 10）",
  ],
  [
    "mentionPath: rootPath === searchRootPath ? entry.relativePath : entry.path,",
    "额外 root 的候选一律绝对路径：同名相对路径会被接收方按自己的 cwd 解析到另一个项目 root 的文件上",
  ],
];

const source = normalize(await readFile(PROVIDER, "utf8"));

for (const [snippet, why] of CONTRACTS) {
  test(`fileMentionProvider 接线：${why}`, () => {
    assert.ok(
      source.includes(normalize(snippet)),
      `${PROVIDER} 必须保留这条接线（${why}）。实际未找到：${snippet}`,
    );
  });
}

test("两个依赖数组都带搜索根事实与规则根（漏一个 ⇒ 换根后沿用旧闭包与旧候选）", () => {
  const scopeDeps = depsAfter(source, "lastMissQuery: null as string | null, }),");
  const effectDeps = depsAfter(source, "return () => { active = false; };");
  for (const [name, deps] of [
    ["scope", scopeDeps],
    ["effect", effectDeps],
  ]) {
    for (const key of ["searchRootPath", "searchRootResolved", "ignoreRulesRoot"]) {
      assert.ok(deps.includes(key), `${name} 依赖数组缺少 ${key}（${deps.join(", ")}）`);
    }
    assert.ok(
      !deps.includes("workspacePath"),
      `${name} 依赖数组仍引用未声明的 workspacePath（${deps.join(", ")}）`,
    );
  }
});

test("退休的 accessor 项目面与未使用的 useServices import 都不复活", () => {
  assert.ok(!source.includes("services.projectService"), "不得再走 accessor 上的项目服务面");
  assert.ok(
    !source.includes('from "@/hooks/useServices.js"'),
    "useServices import 已随接线迁移移除，留着就是未使用导入",
  );
  assert.ok(
    !source.includes("const { fileService, projectService } = services;"),
    "项目服务必须单独经 windowProjectDirectory 取，不能和 fileService 一起解构",
  );
});

test("异步取消门禁保持现状（取根后一次 + 三处 await/错误分支后各一次）", () => {
  assert.ok(
    source.includes("if (!active) return [];"),
    "read() 取到根之后、发请求之前必须检查换代，迟到的 readRoots 结果不能进入新 scope",
  );
  const gates = source.split("if (!active) return;").length - 1;
  assert.equal(
    gates,
    3,
    `期望三处 await 后的取消门禁（首扫 / 补扫 / catch），实际 ${gates} 处；漏掉任一处都会让换代后的迟到响应或错误写进新 scope`,
  );
});

test("两个调用方都按 (FileReferenceRoot, tab workspacePath, identity) 传参，顺序不换", async () => {
  const call =
    "useFileMentionProvider( { resolved: fileReferenceRootResolved, rootPath: fileSearchRootPath }, workspacePath, workspaceIdentity,";
  for (const path of [
    "packages/ui/src/mentions/MentionPlugin.tsx",
    "packages/ui/src/prompt-editor/ChatPromptActionMenu.tsx",
  ]) {
    const caller = normalize(await readFile(path, "utf8"));
    assert.ok(
      caller.includes(normalize(call)),
      `${path} 必须把会话搜索根（含来源事实）与 tab 身份根分开传给 provider，顺序不能换`,
    );
  }
});
