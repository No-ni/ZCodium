import assert from "node:assert/strict";
import test from "node:test";
import {
  compileRestrictedCel,
  compileModelOptionMap,
} from "../../../packages/model-option-map/src/compiler.ts";

test("合法算术产生的负零与零相等，条件 Map 选择正确请求分支", () => {
  const input = 8192;
  assert.equal(
    compileRestrictedCel("-(maxOutputTokens - maxOutputTokens) == 0", "maxOutputTokens").evaluate(
      input,
    ),
    true,
  );
  assert.equal(
    compileRestrictedCel("-(maxOutputTokens - maxOutputTokens) != 0", "maxOutputTokens").evaluate(
      input,
    ),
    false,
  );
  const result = compileModelOptionMap(
    '-(maxOutputTokens - maxOutputTokens) == 0 ? {"max_tokens": maxOutputTokens} : {}',
    "maxOutputTokens",
  ).evaluate(input);
  assert.equal(result.max_tokens, input);
});

test("嵌套数组／对象数值比较采用同一语义并保持类型隔离", () => {
  assert.equal(
    compileRestrictedCel('[{"n": -0}] == [{"n": 0}]', "maxOutputTokens").evaluate(1),
    true,
  );
  assert.equal(compileRestrictedCel('0 == "0"', "maxOutputTokens").evaluate(1), false);
  assert.equal(compileRestrictedCel("false == 0", "maxOutputTokens").evaluate(1), false);
});
