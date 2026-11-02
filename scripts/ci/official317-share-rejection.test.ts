// 本地分享拒绝结构（conversationShareRejectionSchema）与 UI 消费方（getConversationShareErrorDetails）的
// 安全边界测试：只接收 snake_case 规则与结构坐标，绝对路径/URL/控制字符/超长坐标不得进入已 parse 的输出，
// 错误展示不得包含路径原文。可选坐标 catch 成 undefined、未知 key 走 strict 整体拒绝，均为现有 schema 契约。
// 直接导入 packages/shared 与 packages/ui 的真实实现，不在测试里复制校验算法。
import assert from "node:assert/strict";
import test from "node:test";
import { conversationShareRejectionSchema } from "../../packages/shared/src/conversation-share.js";
import { getConversationShareErrorDetails } from "../../packages/ui/src/lib/conversationShareError.js";

const SECRET = "victim-secret-path";

const COORDINATE_FIELDS = ["path", "field", "row_kind"] as const;

// 恶意坐标样本：Windows/Unix 绝对路径、URL、控制字符、超过 schema 上限的超长串（各串含唯一哨兵 SECRET）。
const MALICIOUS_COORDINATES: string[] = [
  `C:\\Users\\${SECRET}\\secret.pdf`,
  `/home/${SECRET}/secret.pdf`,
  `https://example.com/${SECRET}`,
  `segment\u0000${SECRET}`,
  `${"x".repeat(49)}${SECRET}`,
];

function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return value.includes(SECRET);
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).some((entry) => containsSecret(entry));
  }
  return false;
}

test("合法 snake_case 规则与安全结构坐标原样通过，可选坐标缺省为既有契约", () => {
  const parsed = conversationShareRejectionSchema.safeParse({
    rule: "unsafe_structure",
    path: "rows[3].segments[0]",
    field: "content_text",
    row_index: 42,
    row_kind: "assistant_message",
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.rule, "unsafe_structure");
    assert.equal(parsed.data.path, "rows[3].segments[0]");
    assert.equal(parsed.data.field, "content_text");
    assert.equal(parsed.data.row_index, 42);
    assert.equal(parsed.data.row_kind, "assistant_message");
  }

  // 坐标全部可选（optional + catch undefined），只要求 rule；缺省不报错。
  const minimal = conversationShareRejectionSchema.safeParse({ rule: "running_turn" });
  assert.equal(minimal.success, true);
  if (minimal.success) {
    assert.equal(minimal.data.rule, "running_turn");
    assert.equal(minimal.data.path, undefined);
    assert.equal(minimal.data.field, undefined);
    assert.equal(minimal.data.row_index, undefined);
    assert.equal(minimal.data.row_kind, undefined);
  }
});

test("非 snake_case 规则整体解析失败（rule 无 catch，不做静默放行）", () => {
  const badRules: unknown[] = [
    "Unsafe_Structure",
    "unsafe-structure",
    "unsafe structure",
    "unsafe.structure",
    "unsafe/path",
    "9unsafe",
    "_unsafe",
    "",
    `C:/Users/${SECRET}/secret.pdf`,
    "unsafe".repeat(11), // 超过规则长度上限 64
  ];
  for (const rule of badRules) {
    const parsed = conversationShareRejectionSchema.safeParse({ rule });
    assert.equal(parsed.success, false, `rule ${JSON.stringify(rule)} 必须被拒绝`);
    if (parsed.success) {
      assert.equal(containsSecret(parsed.data), false, "被拒绝的规则不得出现在已 parse 输出中");
    }
  }
});

test("strict 对象拒绝未知 key（如携带真实路径的 original_path）", () => {
  const withUnknownPath = conversationShareRejectionSchema.safeParse({
    rule: "unsafe_structure",
    original_path: `C:\\Users\\${SECRET}\\secret.pdf`,
  });
  assert.equal(withUnknownPath.success, false);

  const withUnknownReason = conversationShareRejectionSchema.safeParse({
    rule: "unsafe_structure",
    reason: `read /home/${SECRET}/secret.pdf failed`,
  });
  assert.equal(withUnknownReason.success, false);

  const withNestedUnknown = conversationShareRejectionSchema.safeParse({
    rule: "unsafe_structure",
    extra: { path: `/home/${SECRET}` },
  });
  assert.equal(withNestedUnknown.success, false);
});

test("绝对路径/URL/控制字符/超长坐标被 catch 成 undefined，不进入已 parse 输出", () => {
  for (const field of COORDINATE_FIELDS) {
    for (const value of MALICIOUS_COORDINATES) {
      const parsed = conversationShareRejectionSchema.safeParse({
        rule: "unsafe_structure",
        [field]: value,
      });
      // 现有契约：非法可选坐标不推翻整条结构，而是 catch 成 undefined。
      assert.equal(parsed.success, true, `${field} 携带非法坐标时应按 catch 契约解析成功`);
      if (!parsed.success) continue;
      assert.equal(parsed.data[field], undefined, `${field}=${JSON.stringify(value)} 不得进入输出`);
      assert.equal(containsSecret(parsed.data), false);
    }
  }

  // 坐标长度上限的两侧：65 字符的安全坐标保留，66 字符不保留。
  const atLimit = conversationShareRejectionSchema.safeParse({
    rule: "unsafe_structure",
    path: "b".repeat(65),
  });
  assert.equal(atLimit.success, true);
  if (atLimit.success) assert.equal(atLimit.data.path, "b".repeat(65));
  const overLimit = conversationShareRejectionSchema.safeParse({
    rule: "unsafe_structure",
    path: "b".repeat(66),
  });
  assert.equal(overLimit.success, true);
  if (overLimit.success) assert.equal(overLimit.data.path, undefined);
});

test("row_index 只保留非负安全整数，其余（含缺失与非法类型）catch 成 undefined", () => {
  for (const rowIndex of [0, 7, Number.MAX_SAFE_INTEGER]) {
    const parsed = conversationShareRejectionSchema.safeParse({
      rule: "unsafe_structure",
      row_index: rowIndex,
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.row_index, rowIndex);
      assert.ok(Number.isSafeInteger(parsed.data.row_index) && (parsed.data.row_index ?? -1) >= 0);
    }
  }

  const badIndexes: unknown[] = [
    -1,
    -0.5,
    2.5,
    Number.MAX_SAFE_INTEGER + 2,
    1e308,
    NaN,
    "3",
    null,
    true,
  ];
  for (const rowIndex of badIndexes) {
    const parsed = conversationShareRejectionSchema.safeParse({
      rule: "unsafe_structure",
      row_index: rowIndex,
    });
    assert.equal(parsed.success, true, "非法 row_index 应按既有 catch 契约降级为 undefined");
    if (parsed.success) {
      assert.equal(parsed.data.row_index, undefined, `row_index=${String(rowIndex)} 不得保留`);
    }
  }
});

test("getConversationShareErrorDetails 的错误展示不包含恶意路径原文", () => {
  // 合法 rule + 非法坐标：rejection 结构保留，但坐标降级为 undefined，序列化后无路径原文。
  const sanitized = getConversationShareErrorDetails({
    kind: "unsafe_structure",
    rejection: {
      rule: "unsafe_structure",
      path: `C:\\Users\\${SECRET}\\secret.pdf`,
      field: `https://example.com/${SECRET}`,
      row_index: 2.5,
    },
  });
  assert.ok(sanitized.rejection);
  assert.equal(sanitized.rejection?.rule, "unsafe_structure");
  assert.equal(sanitized.rejection?.path, undefined);
  assert.equal(sanitized.rejection?.field, undefined);
  assert.equal(sanitized.rejection?.row_index, undefined);
  assert.equal(JSON.stringify(sanitized).includes(SECRET), false);

  // 未知 key 触发 strict 拒绝（走 details 嵌套读取路径）：整条 rejection 被丢弃。
  const dropped = getConversationShareErrorDetails({
    kind: "unsafe_structure",
    details: {
      rejection: { rule: "unsafe_structure", original_path: `/home/${SECRET}/secret.pdf` },
    },
  });
  assert.equal("rejection" in dropped, false);
  assert.equal(JSON.stringify(dropped).includes(SECRET), false);

  // rejection 为垃圾输入时不崩溃、不带出 rejection。
  for (const garbage of [undefined, null, "secret", 7, [`C:\\${SECRET}`]]) {
    const details = getConversationShareErrorDetails({
      kind: "unsafe_structure",
      rejection: garbage,
    });
    assert.equal("rejection" in details, false);
    assert.equal(JSON.stringify(details).includes(SECRET), false);
  }
});
