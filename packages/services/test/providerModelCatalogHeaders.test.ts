import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderModelCatalogAttempts } from "../src/model-provider/providerModelCatalog.js";

const cases = [
  ["openai-chat-completions", "authorization"],
  ["openai-responses", "authorization"],
  ["anthropic-messages", "X-API-KEY"],
  ["google-generative-ai", "X-Goog-Api-Key"],
] as const;

for (const [apiType, headerName] of cases) {
  test(`${apiType} custom auth headers replace built-in names case-insensitively`, () => {
    const attempts = buildProviderModelCatalogAttempts({
      apiType,
      baseUrl: "https://provider.example",
      apiKey: "built-in-value",
      headers: { [headerName]: "custom-value" },
    });
    for (const attempt of attempts) {
      // HTTP 会拼接大小写不同的同名头；断言实际 Headers 值以捕获错误鉴权。
      assert.equal(new Headers(attempt.headers).get(headerName), "custom-value");
      assert.equal(
        Object.keys(attempt.headers).filter(
          (name) => name.toLowerCase() === headerName.toLowerCase(),
        ).length,
        1,
      );
    }
  });
}

test("custom Anthropic version replaces the built-in header regardless of spelling", () => {
  const attempts = buildProviderModelCatalogAttempts({
    apiType: "anthropic-messages",
    baseUrl: "https://provider.example",
    apiKey: "built-in-value",
    headers: { "Anthropic-Version": "2024-01-01" },
  });
  for (const attempt of attempts) {
    assert.equal(new Headers(attempt.headers).get("anthropic-version"), "2024-01-01");
    assert.equal(new Headers(attempt.headers).get("x-api-key"), "built-in-value");
  }
});

test("duplicate custom header spellings use the last configured value", () => {
  const attempts = buildProviderModelCatalogAttempts({
    apiType: "openai-chat-completions",
    baseUrl: "https://provider.example",
    apiKey: "built-in-value",
    headers: {
      authorization: "first-value",
      Authorization: "last-value",
      "X-Trace": "first-trace",
      "x-trace": "last-trace",
    },
  });
  for (const attempt of attempts) {
    const headers = new Headers(attempt.headers);
    assert.equal(headers.get("authorization"), "last-value");
    assert.equal(headers.get("x-trace"), "last-trace");
    assert.equal(Object.keys(attempt.headers).length, 2);
  }
});

test("merging catalog headers preserves the caller configuration and winning spelling", () => {
  const headers = Object.freeze({ authorization: "custom-value", "X-Trace": "trace-value" });
  const attempts = buildProviderModelCatalogAttempts({
    apiType: "openai-chat-completions",
    baseUrl: "https://provider.example",
    apiKey: "built-in-value",
    headers,
  });
  assert.deepEqual(headers, { authorization: "custom-value", "X-Trace": "trace-value" });
  for (const attempt of attempts) {
    assert.deepEqual(attempt.headers, headers);
    assert.notEqual(attempt.headers, headers);
  }
});
