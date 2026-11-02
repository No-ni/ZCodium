import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 官方 3.17.1 合并收口：设置页 provider 导航只保留用户自带 Key 的真实 provider，
// 官方 API 服务商（含 ZAI）作为普通 provider 进入同一个 custom 分组；
// 官方退休的 preset/codingPlan/套餐入口不得残留死引用。
const sectionUrl = new URL(
  "../../packages/ui/src/settings/model-provider-section/",
  import.meta.url,
);

const RETIRED_TOKENS = {
  "Navigation.tsx": [
    '"preset"',
    '"codingPlan"',
    "presetId",
    "presetLoading",
    "resolveModelProviderSideNavLabel",
    "shouldShowModelProviderGroupLoadingIndicator",
    "isStartPlanModelProviderId",
    "resolveModelProviderFamilySpecByProviderId",
  ],
  "utils.tsx": [
    "resolveOAuthProviderIdByPreset",
    "PRESET_PROVIDER_SPEC_BY_ID",
    "CODING_PLAN_PROVIDER_SPECS",
    "oauthProviderId",
    "BuiltinModelProviderId",
    "OAuthProviderId",
  ],
};

const RETAINED_SURFACE = {
  "Navigation.tsx": [
    "export function ModelProviderSectionNavigation",
    "export function getSortableProviderId",
    "export function resolveReorderedProviderIdsForGroup",
    "renderModelProviderNavIcon",
    "ProviderStatusIndicator",
    "ModelProviderNavGroup",
  ],
  "utils.tsx": [
    "export function createCustomProviderNodeKey",
    "export function resolveModelProviderNavLogo",
    "export function renderModelProviderNavIcon",
    "export function fuzzyMatch",
    "ProviderLogo",
  ],
};

async function loadSectionSource(fileName) {
  return readFile(new URL(fileName, sectionUrl), "utf8");
}

// 与既有 source 测试同一模式：剥掉 import 后转译真实源码，直接执行生产 helper。
async function loadSectionHelpers(fileName, exportNames) {
  const text = await loadSectionSource(fileName);
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const source = file.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(file).replace(/^export\s+/, ""))
    .join("\n");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
  return new Function(`${js}\nreturn { ${exportNames.join(", ")} };`)();
}

test("官方退休 preset/codingPlan/套餐死引用已从 provider 导航清除", async () => {
  for (const [fileName, tokens] of Object.entries(RETIRED_TOKENS)) {
    const text = await loadSectionSource(fileName);
    for (const token of tokens) {
      assert.ok(!text.includes(token), `${fileName} 仍引用已退休的官方套餐入口: ${token}`);
    }
  }
  const constants = await loadSectionSource("constants.ts");
  assert.ok(constants.includes('type: "custom"'), "constants.ts 必须保留 custom 导航项类型");
  assert.ok(
    !constants.includes("preset") && !constants.includes("codingPlan"),
    "constants.ts 不得残留 preset/codingPlan 类型",
  );
  for (const [fileName, declarations] of Object.entries(RETAINED_SURFACE)) {
    const text = await loadSectionSource(fileName);
    for (const declaration of declarations) {
      assert.ok(
        text.includes(declaration),
        `${fileName} 丢失 BYOK provider 导航依赖的导出: ${declaration}`,
      );
    }
  }
});

test("utils.tsx 从 constants.js 导入的命名必须真实存在", async () => {
  const utilsText = await loadSectionSource("utils.tsx");
  const utilsFile = ts.createSourceFile("utils.tsx", utilsText, ts.ScriptTarget.Latest, true);
  const imported = utilsFile.statements
    .filter(ts.isImportDeclaration)
    .filter((node) => node.moduleSpecifier.getText(utilsFile).includes("constants.js"))
    .flatMap((node) =>
      node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        ? node.importClause.namedBindings.elements.map((element) => element.name.getText(utilsFile))
        : [],
    );
  assert.ok(imported.length > 0, "utils.tsx 必须继续从 constants.js 导入 ModelProviderNavItem");
  const constantsText = await loadSectionSource("constants.ts");
  const constantsFile = ts.createSourceFile(
    "constants.ts",
    constantsText,
    ts.ScriptTarget.Latest,
    true,
  );
  const exported = new Set(
    constantsFile.statements.flatMap((node) => {
      const name = ts.isVariableStatement(node)
        ? node.declarationList.declarations[0]?.name.getText(constantsFile)
        : node.name?.getText(constantsFile);
      const isExported = node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      return isExported && name ? [name] : [];
    }),
  );
  for (const name of imported) {
    assert.ok(exported.has(name), `utils.tsx 导入的 ${name} 不是 constants.ts 的真实导出`);
  }
});

test("用户自带 Key 的普通 provider（含 ZAI）导航 helper 实跑可用", async () => {
  const nav = await loadSectionHelpers("Navigation.tsx", ["getSortableProviderId"]);
  const utils = await loadSectionHelpers("utils.tsx", [
    "createCustomProviderNodeKey",
    "fuzzyMatch",
    "resolveEndpointSuggestionOpenRequest",
    "handleEndpointSuggestionPopoverOpenAutoFocus",
  ]);
  const zaiItem = {
    key: "custom:zai",
    type: "custom",
    label: "Z.ai",
    provider: { providerId: "zai", providerName: "Z.ai" },
    statusActive: true,
  };
  // 官方 API 服务商按普通 provider 参与排序，未被套餐分支拦截。
  assert.equal(nav.getSortableProviderId(zaiItem), "zai");
  assert.equal(nav.getSortableProviderId(zaiItem, new Set(["zai"])), "zai");
  assert.equal(nav.getSortableProviderId(zaiItem, new Set(["other"])), null);
  assert.equal(utils.createCustomProviderNodeKey("zai"), "custom:zai");
  assert.equal(utils.fuzzyMatch("Z.ai", "zai"), true);
  assert.equal(utils.fuzzyMatch("Z.ai", "openai"), false);
  assert.equal(utils.fuzzyMatch("Z.ai", "  "), true);
  assert.deepEqual(
    utils.resolveEndpointSuggestionOpenRequest({ nowMs: 100, suppressOpenUntilMs: 150 }),
    {
      shouldOpen: false,
    },
  );
  assert.deepEqual(
    utils.resolveEndpointSuggestionOpenRequest({ nowMs: 150, suppressOpenUntilMs: 150 }),
    {
      shouldOpen: true,
    },
  );
  let prevented = 0;
  let focused = 0;
  assert.equal(
    utils.handleEndpointSuggestionPopoverOpenAutoFocus({
      keepInputFocus: true,
      preventDefault: () => prevented++,
      focusInput: () => focused++,
    }),
    true,
  );
  assert.equal(prevented, 1);
  assert.equal(focused, 1);
  assert.equal(
    utils.handleEndpointSuggestionPopoverOpenAutoFocus({
      keepInputFocus: false,
      preventDefault: () => prevented++,
      focusInput: () => focused++,
    }),
    false,
  );
  assert.equal(prevented, 1);
  assert.equal(focused, 1);
});

test("普通 provider 导航装配仍走 custom 节点与表单标签", async () => {
  const section = await readFile(
    new URL("../../packages/ui/src/settings/ModelProviderSection.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    section.includes("createCustomProviderNodeKey(provider.providerId)"),
    "ModelProviderSection 必须继续用 custom 节点键装配导航",
  );
  assert.ok(
    section.includes("getProviderFormLabel(provider)"),
    "ModelProviderSection 必须继续用表单标签展示普通 provider",
  );
  assert.ok(
    section.includes('type: "custom"'),
    "ModelProviderSection 必须继续只装配 custom 导航项",
  );
});
