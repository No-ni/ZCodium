import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 3.17.1 目录合并边界守卫：吸收上游模型/供应商目录，同时钉住本仓审计不变量。
// 见 .agents/specs/official-3.17.1-provider.md。只读随包 JSON，不装载运行时。

interface Rule {
  readonly templateId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly modelMatch?: string;
  readonly apiTypeMatch?: string;
  readonly baseUrlMatch?: string;
  readonly config?: {
    readonly access?: { readonly type?: string };
    readonly api?: { readonly type?: string; readonly baseUrl?: string };
  };
}

const load = async (file: string) => {
  const raw = await readFile(new URL(`../../../config/provider/${file}`, import.meta.url), "utf8");
  return { raw, doc: JSON.parse(raw) as { revision: number; config: never } };
};

const rulesOf = (doc: unknown) => {
  const config = (doc as { config: Record<string, Record<string, Rule[]>> }).config;
  return {
    templateRules: config.providerConfigRules.templateRules ?? [],
    providerRules: config.providerConfigRules.providerRules ?? [],
    modelRules: config.modelConfigRules.modelRules ?? [],
    modelApiRules: config.modelConfigRules.modelApiRules ?? [],
    providerSiteRules: config.modelConfigRules.providerSiteRules ?? [],
    templateModelRules: config.modelConfigRules.templateModelRules ?? [],
    builtinProviderModelRules: config.modelConfigRules.builtinProviderModelRules ?? [],
  };
};

const FORK_TEMPLATES = ["opencode-go-google", "opencode-zen-google"];
const UPSTREAM_3171_TEMPLATES = [
  "kimi-code-cn",
  "kimi-code-intl",
  "minimax-m-plan-cn",
  "qwen-coding-plan-cn",
  "qwen-token-plan-team-cn",
  "tencent-tokenhub-cn",
  "tencent-tokenhub-intl",
  "volcengine-ark",
  "volcengine-coding-plan",
  "volcengine-agent-plan",
  "stepfun",
  "stepfun-step-plan",
  "siliconflow-cn",
  "xiaomi-mimo-token-plan",
];

for (const file of ["zcode-builtin.json"]) {
  test(`${file}: 官方账号控制面不随目录回流`, async () => {
    const { doc } = await load(file);
    const rules = rulesOf(doc);
    // 本仓不发布官方账号 Provider：目录级入口必须继续为空。
    assert.deepEqual(rules.providerRules, []);
    assert.deepEqual(rules.builtinProviderModelRules, []);
    assert.equal(
      rules.providerRules.filter((rule) => rule.config?.access?.type === "zhipu-account").length,
      0,
    );
    // 只允许自带 Key：api-key 与用户自有套餐 Key，不引入账号/OAuth 访问类型。
    for (const template of rules.templateRules) {
      assert.ok(
        ["api-key", "zhipu-coding-plan-api-key"].includes(String(template.config?.access?.type)),
        `${template.templateId} 访问类型必须是自带 Key`,
      );
    }
    // 模板端点是真实出网点：任何一条都不得指向官方 ZCode relay。
    for (const template of rules.templateRules) {
      assert.doesNotMatch(String(template.config?.api?.baseUrl ?? ""), /zcode\.z\.ai/);
    }
    assert.equal(doc.revision, 43, "目录序号必须取上游 3.17.1");
  });

  test(`${file}: 上游 3.17.1 目录与本仓 Gemini 原生协议同时在场`, async () => {
    const { doc } = await load(file);
    const rules = rulesOf(doc);
    const ids = new Set(rules.templateRules.map((rule) => rule.templateId));
    for (const id of UPSTREAM_3171_TEMPLATES) assert.ok(ids.has(id), `上游模板 ${id} 丢失`);
    for (const id of FORK_TEMPLATES) assert.ok(ids.has(id), `本仓模板 ${id} 丢失`);
    for (const id of ["zai-api", "zai-standard-api", "bigmodel-api", "bigmodel-standard-api"]) {
      assert.ok(ids.has(id), `自带 Key 模板 ${id} 必须保留`);
    }
    // Gemini 原生协议：兜底 API 规则 + OpenCode 站点规则 + 模板模型规则。
    assert.ok(
      rules.modelApiRules.some(
        (rule) => rule.modelMatch === ".*" && rule.apiTypeMatch === "google-generative-ai",
      ),
      "google-generative-ai API 兜底规则必须保留",
    );
    assert.equal(
      rules.providerSiteRules.filter((rule) => rule.apiTypeMatch === "google-generative-ai").length,
      9,
      "本仓 9 条 OpenCode Gemini 站点规则必须保留",
    );
    const googleTemplateIds = new Set(
      rules.templateModelRules
        .filter((rule) => FORK_TEMPLATES.includes(String(rule.templateId)))
        .map((rule) => `${rule.templateId}|${rule.modelId}`),
    );
    assert.ok(googleTemplateIds.has("opencode-go-google|gemini-4-argon-contributor"));
    assert.equal(googleTemplateIds.size, 9, "本仓 Gemini 模板模型规则数量固定为 9");
    // 每条模型规则引用的模板必须存在，避免剥离账号目录后留下孤立引用。
    for (const rule of rules.templateModelRules) {
      assert.ok(ids.has(rule.templateId), `孤立 templateModelRule: ${rule.templateId}`);
    }
    // 上游 3.17.1 退休的老 MiniMax 型号不得被本仓重新塞回。
    const minimaxRetired = ["MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2"];
    for (const modelId of minimaxRetired) {
      assert.ok(
        !rules.templateModelRules.some(
          (rule) => rule.templateId === "minimax" && rule.modelId === modelId,
        ),
        `${modelId} 已被上游退休，不应恢复`,
      );
    }
  });
}

test("随包 Provider 目录只有单一来源：不引入 ZCODE_ENV 双目录", async () => {
  // HEAD 的边界是开发与打包共用 zcode-builtin.json；上游的 test 目录会带回官方账号入口。
  await assert.rejects(
    readFile(new URL("../../../config/provider/zcode-builtin.test.json", import.meta.url), "utf8"),
    (error) => error.code === "ENOENT",
    "config/provider/zcode-builtin.test.json 不应存在",
  );
  const { raw } = await load("zcode-builtin.json");
  assert.ok(raw.length > 100_000, "唯一目录必须是非空完整来源");
});
