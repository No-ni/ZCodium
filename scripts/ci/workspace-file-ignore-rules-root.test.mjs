import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { tsImport } from "tsx/esm/api";

// 冻结「忽略规则根」契约（docs/specs/conversation-session-workspace.md 规则 10）：
// 规则文件从 ignoreRulesRoot 解析，搜索/遍历仍以搜索根为准；缺省 = 搜索根（逐位等于改动前行为）。
// 对话会话的调用方必须**显式**传对话根：服务层不做"看起来像会话目录"的结构推断，避免出现
// 第二个「谁是对话工作区」的定义。
//
// 「不推断」的用例要断言对话根没有被碰过，因此必须让 fileService 认定一个**临时对话根**：
// paths.ts 在模块加载时捕获
// ZCODE_DATA_BASE_DIR（tsImport 每次调用是独立的模块图，测试侧与 fileService 内部各持一份实例），
// 所以必须在 import fileService **之前**指向临时数据根，让两边读到同一个值。
// 还原必须**紧随动态 import 完成**（下面的 try/finally），不能挂在文件级 after()：
// `--test-isolation=none` 下所有测试文件先被 import，文件级 after() 要等**全部**测试跑完才执行，
// 期间同进程的后续测试文件都会继承本文件的临时数据根（此前正是这个泄漏，注释却写着"立即还原"）。
// 临时目录本身仍由 after() 清理：那是资源回收，早一点晚一点不影响别的测试文件读到的环境。
const dataBaseDir = await mkdtemp(join(tmpdir(), "zcode-file-ignore-data-"));
const inheritedDataBaseDir = process.env.ZCODE_DATA_BASE_DIR;
let workspaceFileIgnoreModule;
let fileServiceModule;
let pathsModule;
process.env.ZCODE_DATA_BASE_DIR = dataBaseDir;
try {
  workspaceFileIgnoreModule = await tsImport(
    "../../packages/services/src/file/workspaceFileIgnore.ts",
    import.meta.url,
  );
  fileServiceModule = await tsImport(
    "../../packages/services/src/file/fileService.ts",
    import.meta.url,
  );
  pathsModule = await tsImport("../../packages/services/src/paths.ts", import.meta.url);
} finally {
  if (inheritedDataBaseDir === undefined) {
    delete process.env.ZCODE_DATA_BASE_DIR;
  } else {
    process.env.ZCODE_DATA_BASE_DIR = inheritedDataBaseDir;
  }
}
after(async () => {
  await rm(dataBaseDir, { recursive: true, force: true });
});

const {
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  loadWorkspaceFileSearchIgnoreRules,
  readWorkspaceFileSearchIgnore,
  resolveWorkspaceFileSearchIgnoreRulesRoot,
  writeWorkspaceFileSearchIgnore,
} = workspaceFileIgnoreModule;
const { createFileService } = fileServiceModule;
const { getConversationWorkspaceDir } = pathsModule;

const IGNORE_FILE = WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME;

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "zcode-file-ignore-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * 建真实布局 `<临时数据根>/.zcodium/workspace/default/<日期>/<会话id前8位>`，
 * 返回服务层认定的对话根与会话目录；用完清掉这一棵对话根，绝不读写真实用户数据。
 */
async function withServiceConversationLayout(fn) {
  const conversationRoot = getConversationWorkspaceDir();
  const sessionDir = join(conversationRoot, "2026-10-11", "a1b2c3d4");
  await mkdir(sessionDir, { recursive: true });
  try {
    await fn({ conversationRoot, sessionDir });
  } finally {
    await rm(conversationRoot, { recursive: true, force: true });
  }
}

async function exists(path) {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

/** 建「对话根 + 会话目录」两层结构，返回两层的路径。 */
async function withConversationLayout(fn) {
  await withTempRoot(async (conversationRoot) => {
    const sessionDir = join(conversationRoot, "2026-10-11", "a1b2c3d4");
    await mkdir(sessionDir, { recursive: true });
    await fn(conversationRoot, sessionDir);
  });
}

test("规则根缺省等于搜索根，归一化与今天逐位一致", () => {
  assert.equal(
    resolveWorkspaceFileSearchIgnoreRulesRoot("/root/project"),
    resolve("/root/project"),
  );
  assert.equal(
    resolveWorkspaceFileSearchIgnoreRulesRoot("/root/project", "   "),
    resolve("/root/project"),
  );
  assert.equal(
    resolveWorkspaceFileSearchIgnoreRulesRoot("/root/project", "/root/default/"),
    resolve("/root/default"),
  );
});

test("缺省：规则文件仍从搜索根读取，且规则文件在那里自动创建", async () => {
  await withTempRoot(async (root) => {
    // 先显式写入规则文件，确认读取位置就是搜索根。
    await writeFile(join(root, IGNORE_FILE), "hidden-by-rules.txt\n", "utf8");
    await writeFile(join(root, "hidden-by-rules.txt"), "x", "utf8");
    await writeFile(join(root, "visible.txt"), "x", "utf8");
    const rules = await loadWorkspaceFileSearchIgnoreRules(root);
    assert.equal(rules.source, "file");

    const emptyRoot = await mkdtemp(join(tmpdir(), "zcode-file-ignore-empty-"));
    try {
      await loadWorkspaceFileSearchIgnoreRules(emptyRoot);
      const created = await readFile(join(emptyRoot, IGNORE_FILE), "utf8");
      assert.match(created, /\.gitignore|ZCode/u);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

test("规则根存在时从该根读规则，会话目录不生成 .zcodiumignore", async () => {
  await withConversationLayout(async (conversationRoot, sessionDir) => {
    await writeFile(join(conversationRoot, IGNORE_FILE), "secret/\n", "utf8");
    await mkdir(join(sessionDir, "secret"), { recursive: true });
    await writeFile(join(sessionDir, "secret", "token.txt"), "x", "utf8");
    await writeFile(join(sessionDir, "notes.txt"), "x", "utf8");

    const rules = await loadWorkspaceFileSearchIgnoreRules(sessionDir, undefined, {
      ignoreRulesRoot: conversationRoot,
    });
    assert.equal(rules.source, "file");
    assert.equal(rules.matcher.ignores("secret/token.txt"), true);
    assert.equal(rules.matcher.ignores("notes.txt"), false);
    // 规则来自对话根，会话目录里**没有**规则文件（否则就违反了「不再自动写入会话目录」）。
    assert.equal(await exists(join(sessionDir, IGNORE_FILE)), false);
  });
});

test("规则根缺文件时只在规则根自动创建，不在搜索根留下规则文件", async () => {
  await withConversationLayout(async (conversationRoot, sessionDir) => {
    await loadWorkspaceFileSearchIgnoreRules(sessionDir, undefined, {
      ignoreRulesRoot: conversationRoot,
    });
    const created = await readFile(join(conversationRoot, IGNORE_FILE), "utf8");
    assert.match(created, /\.gitignore|ZCode/u);
    assert.equal(await exists(join(sessionDir, IGNORE_FILE)), false);
  });
});

test("应用侧文件搜索贯通规则根：搜索根仍是会话目录，排除按对话根规则", async () => {
  await withConversationLayout(async (conversationRoot, sessionDir) => {
    await writeFile(join(conversationRoot, IGNORE_FILE), "secret/\n", "utf8");
    await mkdir(join(sessionDir, "secret"), { recursive: true });
    await writeFile(join(sessionDir, "secret", "token.txt"), "x", "utf8");
    // 同一个 query 的可见控件：证明「token 没匹配上」不是这条断言成立的原因。
    await writeFile(join(sessionDir, "token-visible.txt"), "x", "utf8");
    await writeFile(join(sessionDir, "notes.txt"), "x", "utf8");

    const service = createFileService();
    // 断言用 includes 而不是整数组相等：搜索打分把**绝对路径**也做子序列模糊匹配
    // （packages/shared/src/workspaceFileSearch.ts 的 lowercasePath），`mkdtemp` 的随机目录名
    // 可能让别的候选也命中同一 query（实测约 1–2% 的假红）。另用一个必然可见的文件做正向断言，
    // 才能区分「被规则排除」与「query 没匹配上」。
    const searchRelativePaths = async (query) => {
      const entries = await service.searchWorkspaceFiles({
        ignoreRulesRoot: conversationRoot,
        limit: 50,
        query,
        rootPath: sessionDir,
      });
      return entries.map((entry) => entry.relativePath);
    };
    const withRulesRoot = await searchRelativePaths("token");
    assert.equal(withRulesRoot.includes("token-visible.txt"), true);
    assert.equal(withRulesRoot.includes("secret/token.txt"), false);
    const visible = await searchRelativePaths("notes");
    assert.equal(visible.includes("notes.txt"), true);
    assert.equal(await exists(join(sessionDir, IGNORE_FILE)), false);
  });
});

test("规则根进索引签名：同一搜索根换规则根必须重扫而不是命中旧索引", async () => {
  await withConversationLayout(async (conversationRoot, sessionDir) => {
    await writeFile(join(conversationRoot, IGNORE_FILE), "notes.txt\n", "utf8");
    await writeFile(join(sessionDir, "notes.txt"), "x", "utf8");

    const service = createFileService();
    // 先按会话目录自己的规则（缺省规则根 = 搜索根，无规则文件 → 自动创建空规则）能搜到。
    const withoutRulesRoot = await service.searchWorkspaceFiles({
      limit: 50,
      query: "notes",
      rootPath: sessionDir,
    });
    assert.deepEqual(
      withoutRulesRoot.map((entry) => entry.relativePath),
      ["notes.txt"],
    );
    // 再按对话根规则（notes.txt 被忽略）必须搜不到：签名含规则根才会重扫。
    const withRulesRoot = await service.searchWorkspaceFiles({
      ignoreRulesRoot: conversationRoot,
      limit: 50,
      query: "notes",
      rootPath: sessionDir,
    });
    assert.deepEqual(withRulesRoot, []);
  });
});

test("索引分块接口同样贯通规则根", async () => {
  await withConversationLayout(async (conversationRoot, sessionDir) => {
    await writeFile(join(conversationRoot, IGNORE_FILE), "secret/\n", "utf8");
    await mkdir(join(sessionDir, "secret"), { recursive: true });
    await writeFile(join(sessionDir, "secret", "token.txt"), "x", "utf8");
    await writeFile(join(sessionDir, "notes.txt"), "x", "utf8");

    const service = createFileService();
    const length = await service.listWorkspaceFilesLength({
      ignoreRulesRoot: conversationRoot,
      rootPath: sessionDir,
    });
    const packed = await service.listWorkspaceFilesRange({
      ignoreRulesRoot: conversationRoot,
      length,
      offset: 0,
      rootPath: sessionDir,
    });
    // `length` 是生产按这个字符串自己的长度算出来的（fileService 的 packed.length），
    // 所以 `assert.equal(packed.length, length)` 在空索引下也成立（0 === 0），恒真。
    // 这里断言语义事实：索引非空，且内容按规则根过滤（下两条 match 才是真正的判据）。
    assert.ok(length > 0, `规则根贯通后索引不得为空（实际 length=${length}）`);
    assert.equal(packed.length, length);
    assert.match(packed, /notes\.txt/u);
    assert.doesNotMatch(packed, /token\.txt/u);
  });
});

test("设置页读写也走规则根：内容与搜索读到的是同一个文件", async () => {
  await withConversationLayout(async (conversationRoot, sessionDir) => {
    await writeWorkspaceFileSearchIgnore(sessionDir, "from-settings\n", conversationRoot);
    assert.equal(await readFile(join(conversationRoot, IGNORE_FILE), "utf8"), "from-settings\n");
    assert.equal(await exists(join(sessionDir, IGNORE_FILE)), false);

    const readBack = await readWorkspaceFileSearchIgnore(sessionDir, conversationRoot);
    assert.deepEqual(readBack, { content: "from-settings\n", source: "file" });
    // 缺省（不传规则根）仍是旧行为：在搜索根读，文件不存在时给初始内容预览且不落盘。
    const legacyPreview = await readWorkspaceFileSearchIgnore(sessionDir);
    assert.equal(legacyPreview.source, "template");
    assert.equal(await exists(join(sessionDir, IGNORE_FILE)), false);
  });
});

// ——— 缺省与显式的分工：服务层**不**推断「哪个目录是对话根」 ———
// 唯一所有者是下发标记的 Host 与铸造目录的 CLI：服务层再判一次就会出现两个定义
// （对「嵌在对话根下的项目 workspace」误判、并把规则文件写到错误的位置），而且显式传错值时
// 它也救不回来。因此契约是：显式 ignoreRulesRoot 优先，缺省 = 搜索根；对话会话的调用方
// （UI 文件树 / 提及 / Cmd+P / 设置页，见 packages/ui 的四个调用点）显式传对话根。
// 这些用例固定「不推断」这一条：漏传时规则文件落在搜索根自己，绝不悄悄挪到对话根。

test("缺省规则根 = 搜索根：会话目录为搜索根时不推断对话根", async () => {
  await withServiceConversationLayout(async ({ conversationRoot, sessionDir }) => {
    await writeFile(join(sessionDir, "notes.txt"), "x", "utf8");
    const service = createFileService();
    const entries = await service.searchWorkspaceFiles({
      limit: 50,
      query: "notes",
      rootPath: sessionDir,
    });
    assert.deepEqual(
      entries.map((entry) => entry.relativePath),
      ["notes.txt"],
    );
    // 规则文件落在搜索根（调用方自己的目录）——这是缺省语义，不是"兜底失败"。
    assert.match(await readFile(join(sessionDir, IGNORE_FILE), "utf8"), /\.gitignore|ZCode/u);
    // 关键断言：服务层没有因为"搜索根在对话根之下"就去动对话根。
    assert.equal(await exists(join(conversationRoot, IGNORE_FILE)), false);
  });
});

test("显式传对话根作规则根时，对话根的规则真的作用于会话目录", async () => {
  await withServiceConversationLayout(async ({ conversationRoot, sessionDir }) => {
    await writeFile(join(conversationRoot, IGNORE_FILE), "secret/\n", "utf8");
    await mkdir(join(sessionDir, "secret"), { recursive: true });
    await writeFile(join(sessionDir, "secret", "token.txt"), "x", "utf8");
    await writeFile(join(sessionDir, "notes.txt"), "x", "utf8");

    const service = createFileService();
    // 断言用 includes 而不是整数组相等：搜索会模糊匹配绝对路径，临时目录随机名可能让别的候选也命中。
    const searchRelativePaths = async (query) => {
      const entries = await service.searchWorkspaceFiles({
        ignoreRulesRoot: conversationRoot,
        limit: 50,
        query,
        rootPath: sessionDir,
      });
      return entries.map((entry) => entry.relativePath);
    };
    // 两个查询都能命中 notes.txt，证明被排除的是「对话根规则命中的 token.txt」而不是查询没匹配上。
    for (const query of ["txt", "notes"]) {
      const relativePaths = await searchRelativePaths(query);
      assert.equal(relativePaths.includes("notes.txt"), true);
      assert.equal(relativePaths.includes("secret/token.txt"), false);
    }
    assert.equal(await exists(join(sessionDir, IGNORE_FILE)), false);
    // 设置页读回的也是对话根那一份（同一个规则根，不会编辑出第二个规则文件）。
    const readBack = await service.readWorkspaceFileSearchIgnore({
      ignoreRulesRoot: conversationRoot,
      rootPath: sessionDir,
    });
    assert.deepEqual(readBack, { content: "secret/\n", source: "file" });
  });
});

test("显式规则根是唯一读写位置，不被其它目录影响", async () => {
  await withServiceConversationLayout(async ({ conversationRoot, sessionDir }) => {
    await withTempRoot(async (explicitRulesRoot) => {
      await writeFile(join(explicitRulesRoot, IGNORE_FILE), "notes.txt\n", "utf8");
      await writeFile(join(sessionDir, "notes.txt"), "x", "utf8");

      const service = createFileService();
      const entries = await service.searchWorkspaceFiles({
        ignoreRulesRoot: explicitRulesRoot,
        limit: 50,
        query: "notes",
        rootPath: sessionDir,
      });
      assert.deepEqual(entries, []);
      assert.equal(await exists(join(sessionDir, IGNORE_FILE)), false);
      assert.equal(await exists(join(conversationRoot, IGNORE_FILE)), false);

      await service.writeWorkspaceFileSearchIgnore({
        content: "from-settings\n",
        ignoreRulesRoot: explicitRulesRoot,
        rootPath: sessionDir,
      });
      assert.equal(await readFile(join(explicitRulesRoot, IGNORE_FILE), "utf8"), "from-settings\n");
      assert.equal(await exists(join(sessionDir, IGNORE_FILE)), false);
      assert.equal(await exists(join(conversationRoot, IGNORE_FILE)), false);
    });
  });
});

test("rootPath 等于对话根时行为不变：规则根仍是它自己", async () => {
  await withServiceConversationLayout(async ({ conversationRoot }) => {
    await writeFile(join(conversationRoot, "notes.txt"), "x", "utf8");
    const service = createFileService();
    const entries = await service.searchWorkspaceFiles({
      limit: 50,
      query: "notes",
      rootPath: conversationRoot,
    });
    // 断言用 includes：搜索根是对话根，会话目录也在索引里，模糊匹配可能带出目录候选。
    const relativePaths = entries.map((entry) => entry.relativePath);
    assert.equal(relativePaths.includes("notes.txt"), true);
    assert.equal(relativePaths.includes(IGNORE_FILE), false);
    const created = await readFile(join(conversationRoot, IGNORE_FILE), "utf8");
    assert.match(created, /\.gitignore|ZCode/u);
    // 设置页读到的也是这一份（source: file），说明读写位置仍是对话根自己。
    assert.deepEqual(await service.readWorkspaceFileSearchIgnore({ rootPath: conversationRoot }), {
      content: created,
      source: "file",
    });
  });
});

test("形如 <对话根>-sibling 的兄弟目录：规则根仍是搜索根自己", async () => {
  await withServiceConversationLayout(async ({ conversationRoot }) => {
    const siblingSessionDir = join(`${conversationRoot}-sibling`, "2026-10-11", "a1b2c3d4");
    await mkdir(siblingSessionDir, { recursive: true });
    await writeFile(join(siblingSessionDir, "notes.txt"), "x", "utf8");

    const service = createFileService();
    const entries = await service.searchWorkspaceFiles({
      limit: 50,
      query: "notes",
      rootPath: siblingSessionDir,
    });
    assert.deepEqual(
      entries.map((entry) => entry.relativePath),
      ["notes.txt"],
    );
    // 规则文件落在搜索根自己，对话根不生成规则文件。
    assert.match(
      await readFile(join(siblingSessionDir, IGNORE_FILE), "utf8"),
      /\.gitignore|ZCode/u,
    );
    assert.equal(await exists(join(conversationRoot, IGNORE_FILE)), false);
  });
});
