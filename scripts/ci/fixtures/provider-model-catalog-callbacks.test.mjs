import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import {
  markCatalogItemsAdded,
  resolveModelCatalogItems,
  summarizeCatalogAddResults,
  withCatalogMetadata,
} from "../../../packages/ui/src/settings/model-provider-section/providerModelCatalogSelection.ts";
import enUS from "../../../packages/ui/src/i18n/locales/en-US.ts";
import zhCN from "../../../packages/ui/src/i18n/locales/zh-CN.ts";
import { loadComponentCallback } from "./component-callback.mjs";

const component = "packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx";
const createEmptyModel = await loadComponentCallback(component, "createEmptyModel", {});
const marker = "SYNTHETIC_CATALOG_PRIVATE_MARKER";

// 直接执行生产 callback；只替换服务、React setter 与 intl 边界，所有数据均在内存中。
function createIntl(locale) {
  const messages = locale === "zh-CN" ? zhCN : enUS;
  return {
    formatMessage({ id }, values = {}) {
      return Object.entries(values).reduce(
        (text, [key, value]) => text.replaceAll("{" + key + "}", String(value)),
        messages[id] ?? id,
      );
    },
  };
}

async function confirmationFixture({ locale = "en-US", add = async () => {} } = {}) {
  const state = {
    saving: false,
    error: null,
    open: true,
    items: resolveModelCatalogItems(["catalog-a", "catalog-b", "catalog-c"], []),
    writes: [],
    logs: [],
  };
  const catalogSavingRef = { current: false };
  const confirm = await loadComponentCallback(component, "confirmCatalogSelection", {
    catalogSavingRef,
    setCatalogSaving: (value) => {
      state.saving = value;
    },
    setCatalogError: (value) => {
      state.error = value;
    },
    setCatalogItems: (update) => {
      state.items = update(state.items);
    },
    setCatalogDialogOpen: (value) => {
      state.open = value;
    },
    onAddModel: async (model) => {
      state.writes.push(model);
      await add(model);
    },
    providerId: "SYNTHETIC_PRIVATE_PROVIDER_ID",
    catalogMetadata: { "catalog-a": { contextWindow: 16384, maxOutputTokens: 4096 } },
    createEmptyModel,
    withCatalogMetadata,
    summarizeCatalogAddResults,
    markCatalogItemsAdded,
    intl: createIntl(locale),
    logger: { warn: (...args) => state.logs.push(args) },
  });
  return { state, catalogSavingRef, confirm };
}

test("PCAT03: 同一同步栈重复确认只启动一批串行写入", async () => {
  const gate = Promise.withResolvers();
  const f = await confirmationFixture({ add: () => gate.promise });
  const first = f.confirm(["catalog-a", "catalog-b"]);
  const duplicate = f.confirm(["catalog-a", "catalog-b"]);
  try {
    assert.deepEqual(
      f.state.writes.map((model) => model.modelId),
      ["catalog-a"],
    );
    assert.equal(f.state.saving, true);
  } finally {
    gate.resolve();
    await Promise.all([first, duplicate]);
  }
  assert.deepEqual(
    f.state.writes.map((model) => model.modelId),
    ["catalog-a", "catalog-b"],
  );
  assert.equal(f.catalogSavingRef.current, false);
  assert.equal(f.state.saving, false);
});

test("目录仍串行保存真实 metadata，成功项只读，失败可重试", async () => {
  const gate = Promise.withResolvers();
  let failB = true;
  const f = await confirmationFixture({
    add: async (model) => {
      if (model.modelId === "catalog-a") await gate.promise;
      if (model.modelId === "catalog-b" && failB) throw new Error(marker);
    },
  });
  const flight = f.confirm(["catalog-a", "catalog-b"]);
  try {
    assert.deepEqual(
      f.state.writes.map((model) => model.modelId),
      ["catalog-a"],
    );
  } finally {
    gate.resolve();
    await flight;
  }
  assert.deepEqual(f.state.writes[0].personalConfig, {
    properties: { contextWindow: 16384 },
    optionSpecs: { maxOutputTokens: { max: 4096 } },
  });
  assert.deepEqual(f.state.items, [
    { modelId: "catalog-a", alreadyAdded: true },
    { modelId: "catalog-b", alreadyAdded: false },
    { modelId: "catalog-c", alreadyAdded: false },
  ]);
  assert.equal(f.state.error, "Added 1 models, 1 failed.");
  assert.equal(f.state.open, true);
  assert.equal(f.catalogSavingRef.current, false);
  failB = false;
  await f.confirm(["catalog-b"]);
  assert.deepEqual(
    f.state.writes.map((model) => model.modelId),
    ["catalog-a", "catalog-b", "catalog-b"],
  );
  assert.equal(f.state.error, null);
  assert.equal(f.state.open, false);
});

for (const locale of ["en-US", "zh-CN"]) {
  test("PCAT04: " + locale + " 添加抛错不输出原始异常或业务 ID", async () => {
    const f = await confirmationFixture({
      locale,
      add: async () => {
        throw new Error(marker);
      },
    });
    await f.confirm(["catalog-a"]);
    assert.equal(
      f.state.error,
      locale === "zh-CN" ? "已添加 0 个模型，1 个失败。" : "Added 0 models, 1 failed.",
    );
    assert.equal(f.state.saving, false);
    assert.equal(f.catalogSavingRef.current, false);
    assert.equal(f.state.open, true);
    assert.equal(f.state.logs.length, 1);
    assert.equal(f.state.logs[0].length, 1, "日志只能包含固定诊断文本");
    for (const value of [marker, "SYNTHETIC_PRIVATE_PROVIDER_ID", "catalog-a"]) {
      assert.equal(inspect(f.state.logs).includes(value), false);
    }
  });

  for (const thrown of [new Error(marker), marker]) {
    test(
      "PCAT04: " +
        locale +
        " 目录抛出 " +
        (typeof thrown === "string" ? "string" : "Error") +
        " 使用稳定提示",
      async () => {
        const state = {
          items: ["old"],
          metadata: { old: {} },
          error: null,
          loading: false,
          open: false,
        };
        const intl = createIntl(locale);
        const resolveCatalogFailureMessage = await loadComponentCallback(
          component,
          "resolveCatalogFailureMessage",
          { intl },
        );
        const open = await loadComponentCallback(component, "openCatalogDialog", {
          onFetchModels: async () => {
            throw thrown;
          },
          catalogRequestRef: { current: 0 },
          existingModelIds: [],
          resolveModelCatalogItems,
          resolveCatalogFailureMessage,
          setCatalogDialogOpen: (value) => {
            state.open = value;
          },
          setCatalogLoading: (value) => {
            state.loading = value;
          },
          setCatalogError: (value) => {
            state.error = value;
          },
          setCatalogItems: (value) => {
            state.items = value;
          },
          setCatalogMetadata: (value) => {
            state.metadata = value;
          },
        });
        await open();
        assert.equal(
          state.error,
          locale === "zh-CN"
            ? "获取模型列表失败：接口请求失败"
            : "Failed to fetch models: The endpoint request failed",
        );
        assert.deepEqual(state.items, []);
        assert.deepEqual(state.metadata, {});
        assert.equal(state.loading, false);
        assert.equal(state.open, true);
        assert.equal(state.error.includes(marker), false);
      },
    );
  }
}
