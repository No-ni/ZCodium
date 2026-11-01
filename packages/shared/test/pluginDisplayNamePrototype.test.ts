import assert from "node:assert/strict";
import test from "node:test";
import { formatCanonicalPluginName, resolvePluginDisplayName } from "../src/plugin-display-name.js";

test("合法 constructor 名称不读取对象原型，保留原始大小写", () => {
  for (const [name, expected] of [
    ["constructor", "Constructor"],
    ["Constructor", "Constructor"],
    ["CONSTRUCTOR", "CONSTRUCTOR"],
  ]) {
    assert.equal(formatCanonicalPluginName(name!, "en-US"), expected);
  }
});

test("任意 slug 分段中的 constructor 都使用普通名称规则", () => {
  assert.equal(formatCanonicalPluginName("aws-constructor", "en-US"), "AWS Constructor");
  assert.equal(formatCanonicalPluginName("my_constructor", "en-US"), "My Constructor");
  assert.equal(formatCanonicalPluginName("constructor-mcp", "en-US"), "Constructor MCP");
});

test("显式缩写、分隔符与普通分段保持既有格式", () => {
  assert.equal(
    formatCanonicalPluginName("  AWS_mcp--zcode_myPlugin  ", "en-US"),
    "AWS MCP ZCode MyPlugin",
  );
  assert.equal(formatCanonicalPluginName("my-plugin", "en-US"), "My Plugin");
});

test("其他原型名称仍按既有分词与大小写规则展示", () => {
  assert.equal(formatCanonicalPluginName("__proto__", "en-US"), "Proto");
  assert.equal(formatCanonicalPluginName("toString", "en-US"), "ToString");
  assert.equal(formatCanonicalPluginName("hasOwnProperty", "en-US"), "HasOwnProperty");
});

test("空名称、空白与纯分隔符不产生新文字", () => {
  for (const name of ["", "  ", "-_-", " _--_ "]) {
    assert.equal(formatCanonicalPluginName(name, "en-US"), "");
  }
});

test("未知缩写的首字符继续按指定 locale 大写", () => {
  assert.equal(formatCanonicalPluginName("istanbul-tools", "tr-TR"), "İstanbul Tools");
});

test("公开名称入口保留 listing 优先级与缺失时的 slug 回退", () => {
  const plugin = {
    name: "constructor",
    listing: {
      displayName: "Catalogue",
      displayNameI18n: { "zh-CN": "目录名称", "en-GB": "British name" },
    },
  };
  assert.equal(resolvePluginDisplayName(plugin, "zh-CN"), "目录名称");
  assert.equal(resolvePluginDisplayName(plugin, "zh-TW"), "目录名称");
  assert.equal(resolvePluginDisplayName(plugin, "en-US"), "British name");
  assert.equal(resolvePluginDisplayName(plugin, "fr-FR"), "Catalogue");
  assert.equal(
    resolvePluginDisplayName({ name: "constructor", listing: { displayName: "" } }, "en-US"),
    "",
  );
  assert.equal(
    resolvePluginDisplayName({ name: "constructor", listing: {} }, "en-US"),
    "Constructor",
  );
  assert.equal(resolvePluginDisplayName({ name: "constructor" }, "en-US"), "Constructor");
});
