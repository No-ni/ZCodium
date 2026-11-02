import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 插件商店的在途操作只有一份事实：pluginManagementStore.activeOperations。
// 这里固定两条边界：Page 只接该真实合同；判定按 operation.id 逐插件匹配，
// 不同插件的并发操作不会把彼此的控件置灰，也不复活退休的单值 operationId。

const pagePath = "packages/ui/src/settings/PluginStorePage.tsx";
const uninstallHookPath = "packages/ui/src/settings/usePluginUninstall.ts";
const actionsPath = "packages/ui/src/settings/pluginStoreActions.ts";
const sourcesDialogPath = "packages/ui/src/settings/PluginStoreSourcesDialog.tsx";
const addSourceDialogPath = "packages/ui/src/settings/AddMarketplaceSourceDialog.tsx";
const listViewPath = "packages/ui/src/settings/PluginStoreListView.tsx";
const listingPath = "packages/ui/src/settings/pluginStoreListing.ts";

async function readSource(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

// 直接执行生产源码里的真实声明，避免把判定逻辑抄进测试后失去回归意义。
async function loadSourceDeclaration(path, name, dependencies = {}) {
  const text = await readSource(path);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = [];
  const visit = (node) => {
    const isNamed =
      node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === name;
    if (isNamed && (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node))) {
      declarations.push(ts.isFunctionDeclaration(node) ? node : node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(declarations.length, 1, `Expected one production declaration: ${name}`);
  // getText 保留 export 修饰符，包一层 const 前先剥掉，避免语法错误。
  const declaration = declarations[0].getText(source).replace(/^export\s+(default\s+)?/, "");
  const { outputText } = ts.transpileModule(`const value = ${declaration};`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return new Function(...Object.keys(dependencies), `${outputText}\nreturn value;`)(
    ...Object.values(dependencies),
  );
}

const operation = (id) => ({ id });
const pluginItem = (id) => ({ id, name: id, marketplace: "zcode-plugins-official" });

test("在途操作按 operation.id 逐插件匹配，不同插件的并发不全禁用", async () => {
  const isItemBusy = await loadSourceDeclaration(listingPath, "isItemBusy");
  const itemA = pluginItem("plugin-a");
  const itemB = pluginItem("plugin-b");
  // A 更新中只置灰 A；B 仍可提交自己的安装/更新，后端按提交顺序串行执行。
  assert.equal(
    isItemBusy(itemA, {
      activeOperations: [operation("plugin:update:plugin-a")],
      togglingPluginId: null,
    }),
    true,
  );
  assert.equal(
    isItemBusy(itemB, {
      activeOperations: [operation("plugin:update:plugin-a")],
      togglingPluginId: null,
    }),
    false,
  );
  // 市场源刷新与来源增删是全局操作，不能把插件卡片一起置灰。
  for (const id of [
    "marketplace:update:zcode-plugins-official",
    "marketplace:add:fixture-source",
    "marketplace:remove:fixture-source",
  ]) {
    assert.equal(
      isItemBusy(itemA, { activeOperations: [operation(id)], togglingPluginId: null }),
      false,
      id,
    );
    assert.equal(
      isItemBusy(itemB, { activeOperations: [operation(id)], togglingPluginId: null }),
      false,
      id,
    );
  }
  // 另一个插件的同名并发操作不构成本插件的忙态。
  assert.equal(
    isItemBusy(itemA, {
      activeOperations: [operation("plugin:install:plugin-b@zcode-plugins-official")],
      togglingPluginId: null,
    }),
    false,
  );
  // 多条目并存时仍按目标 id 命中。
  assert.equal(
    isItemBusy(itemB, {
      activeOperations: [
        operation("plugin:update:plugin-a"),
        operation("plugin:uninstall:plugin-b"),
      ],
      togglingPluginId: null,
    }),
    true,
  );
  assert.equal(
    isItemBusy(itemA, {
      activeOperations: [
        operation("plugin:update:plugin-a"),
        operation("plugin:uninstall:plugin-b"),
      ],
      togglingPluginId: null,
    }),
    true,
  );
});

test("卸载确认只跟随目标插件的 plugin:uninstall 条目", async () => {
  const evaluate = (pendingId, activeOperations) =>
    loadSourceDeclaration(uninstallHookPath, "uninstalling", { pendingId, activeOperations });
  assert.equal(await evaluate(null, []), false);
  assert.equal(await evaluate("plugin-a", []), false);
  assert.equal(await evaluate("plugin-a", [operation("plugin:uninstall:plugin-b")]), false);
  assert.equal(
    await evaluate("plugin-a", [
      operation("plugin:update:plugin-a"),
      operation("plugin:uninstall:plugin-b"),
    ]),
    false,
  );
  assert.equal(await evaluate("plugin-a", [operation("plugin:uninstall:plugin-a")]), true);
});

test("商店页把 activeOperations 接进卸载、卡片动作与两个来源对话框", async () => {
  const page = await readSource(pagePath);
  assert.match(page, /usePluginManagementStore\(\(state\) => state\.activeOperations\)/);
  assert.match(
    page,
    /usePluginUninstall\(\{\s*pluginService: pluginManagementService,\s*installedPlugins,\s*plugins,\s*activeOperations,/,
  );
  assert.match(page, /activeOperations,\s*togglingPluginId: null/);
  // 详情更新按钮按目标插件判定，A 的更新不能置灰 B 的详情更新。
  assert.match(
    page,
    /activeOperations\.some\(\s*\(operation\) => operation\.id === `plugin:update:\$\{detailItem\.id\}`/,
  );
  // 列表 loading 只跟随市场源刷新，任何插件操作都不能把整个列表置灰。
  assert.match(
    page,
    /loading=\{\s*loading \|\|\s*activeOperations\.some\(\s*\(operation\) => operation\.id\.startsWith\("marketplace:update:"\)/,
  );
  const [sourcesPart, addSourcePart = ""] = page.split("<AddMarketplaceSourceDialog");
  assert.match(sourcesPart, /<PluginStoreSourcesDialog/);
  assert.match(sourcesPart, /activeOperations=\{activeOperations\}/);
  assert.match(addSourcePart, /activeOperations=\{activeOperations\}/);
  // 未安装条目仍从同一个 actions 合同取忙态，不新建第二份进行中状态。
  assert.ok(!page.includes("operationId"), "退休的单值 operationId 不能回来");
});

test("技能收尾只失效草稿会话，不再解析已退休的 session service", async () => {
  const page = await readSource(pagePath);
  const call = /invalidateDeferredDraftSessionForSkillChange\(\{([\s\S]*?)\}\)/.exec(page);
  assert.ok(call, "插件 package 变更仍走既有草稿失效通道");
  assert.ok(!call[1].includes("zcodeSessionService"), "已退休的 zcodeSessionService 字段不能回来");
  assert.match(call[1], /workspacePath,/);
  assert.match(call[1], /workspaceIdentity: normalizedWorkspaceIdentity/);
  assert.match(call[1], /reason: "settings-plugin-enabled"/);
  assert.match(page, /refreshSharedSkillStoreForWorkspace\(\{/);
  assert.ok(!page.includes("useZCodeSessionService"), "只为该字段存在的 hook 调用要一起退休");
  assert.ok(!page.includes("zcodeSessionService"));
});

test("并列旧管理入口退休，列表视图不接收 onOpenManage", async () => {
  const page = await readSource(pagePath);
  assert.ok(!page.includes("onManageInstalled"), "并列插件管理入口已退休");
  assert.ok(!page.includes("onOpenManage"), "PluginStoreListView 没有该合同");
  const listView = await readSource(listViewPath);
  assert.ok(!listView.includes("onOpenManage"), "列表视图不声明该 prop");
});

test("卸载钩子、卡片动作与两个来源对话框都以 activeOperations 数组为合同", async () => {
  const uninstallHook = await readSource(uninstallHookPath);
  assert.match(uninstallHook, /activeOperations: ReadonlyArray<\{ id: string \}>/);
  assert.match(
    uninstallHook,
    /activeOperations\.some\(\(operation\) => operation\.id === `plugin:uninstall:\$\{pendingId\}`\)/,
  );
  const actions = await readSource(actionsPath);
  assert.match(
    actions,
    /interface PluginStoreActions \{[\s\S]*?activeOperations: ReadonlyArray<\{ id: string \}>/,
  );
  const sourcesDialog = await readSource(sourcesDialogPath);
  assert.match(sourcesDialog, /activeOperations: ReadonlyArray<\{ id: string \}>/);
  assert.match(
    sourcesDialog,
    /activeOperations\.some\(\s*\(operation\) => operation\.id === `marketplace:update:\$\{marketplace\.id\}`/,
  );
  assert.match(
    sourcesDialog,
    /activeOperations\.some\(\s*\(operation\) => operation\.id === `marketplace:remove:\$\{marketplace\.id\}`/,
  );
  const addSourceDialog = await readSource(addSourceDialogPath);
  assert.match(addSourceDialog, /activeOperations: ReadonlyArray<\{ id: string \}>/);
  assert.match(
    addSourceDialog,
    /activeOperations\.some\(\s*\(operation\) => operation\.id === `marketplace:add:\$\{trimmedSource\}`/,
  );
});
