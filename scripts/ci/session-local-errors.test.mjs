import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const path = "packages/ui/src/v4/SessionPane.tsx";
const source = ts.createSourceFile(
  path,
  await readFile(path, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function findOne(predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1);
  return matches[0];
}
function evaluate(node, dependencies) {
  const { outputText } = ts.transpileModule(`const result = ${node.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  });
  return new Function(...Object.keys(dependencies), `${outputText}; return result;`)(
    ...Object.values(dependencies),
  );
}
const forbiddenQuota = new Proxy(
  {},
  {
    get() {
      throw new Error("Official quota must not participate in session UI decisions");
    },
  },
);

test("session errors retain draft/send/control precedence without quota takeover", () => {
  const declaration = findOne(
    (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "composerError",
  );
  const draft = { message: "Fixture model unavailable" },
    send = { message: "Fixture rejected command" },
    control = { code: "1005", message: "Fixture provider failure", traceId: "local-fixture-trace" };
  for (const [draftModelReadinessError, sendSubmissionError, projectedComposerError, expected] of [
    [draft, send, control, draft],
    [null, send, control, send],
    [null, null, control, control],
    [null, null, null, null],
  ]) {
    assert.equal(
      evaluate(declaration.initializer, {
        draftModelReadinessError,
        sendSubmissionError,
        projectedComposerError,
        quotaBanner: forbiddenQuota,
      }),
      expected,
    );
  }
});

test("composer retains connection/rebuild/queue edit gates without account quota reads", () => {
  const element = findOne(
    (node) =>
      ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "ConversationComposer",
  );
  const disabled = element.attributes.properties.find(
    (node) => ts.isJsxAttribute(node) && node.name.text === "disabled",
  );
  assert.ok(disabled && ts.isJsxExpression(disabled.initializer));
  for (const flags of [
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ]) {
    const [connecting, draftRuntimeRebuilding, queueEditActiveForCurrentComposer] = flags;
    assert.equal(
      evaluate(disabled.initializer.expression, {
        connecting,
        draftRuntimeRebuilding,
        queueEditActiveForCurrentComposer,
        quotaBanner: forbiddenQuota,
      }),
      flags.some(Boolean),
    );
  }
});

test("session shell no longer imports official quota or MCP-plan banner logic", () => {
  const imports = source.statements
    .filter(ts.isImportDeclaration)
    .map((node) => node.getText(source))
    .join("\n");
  assert.doesNotMatch(
    imports,
    /QuotaBanner|[Uu]sageEntitlement|mcpUnavailableBannerNotice|startPlanQuota/,
  );
});

const bannerPath = "packages/ui/src/ChatErrorBanner.tsx";
const bannerSource = ts.createSourceFile(
  bannerPath,
  await readFile(bannerPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const providerPath = "packages/ui/src/lib/providerBusinessError.ts";
const providerSource = ts.createSourceFile(
  providerPath,
  await readFile(providerPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

function evaluateDeclarations(sourceFile, names, dependencies) {
  const declarations = sourceFile.statements.filter((node) => {
    const name = ts.isVariableStatement(node)
      ? node.declarationList.declarations[0]?.name.getText(sourceFile)
      : ts.isFunctionDeclaration(node)
        ? node.name?.text
        : undefined;
    return names.includes(name);
  });
  assert.equal(declarations.length, names.length, "All regression declarations must exist");
  const { outputText } = ts.transpileModule(
    declarations.map((node) => node.getText(sourceFile).replace(/^export /, "")).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ESNext } },
  );
  return new Function(
    ...Object.keys(dependencies),
    outputText + "; return { " + names.join(", ") + " };",
  )(...Object.values(dependencies));
}

// 直接执行已有 AST 声明，保留真实历史映射以复现误改写；不装载 React 或共享运行时。
const providerFunctions = evaluateDeclarations(
  providerSource,
  [
    "SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE",
    "PROVIDER_BUSINESS_ERROR_CODES",
    "PROVIDER_BUSINESS_ERROR_MESSAGE_IDS",
    "isProviderBusinessErrorCode",
    "getProviderBusinessErrorMessageId",
    "resolveOffPeakTicketExpiredBusinessCode",
    "isSuspiciousEmptyModelResultMessage",
  ],
  {
    OFF_PEAK_TICKET_EXPIRED_MARKER: "fixture-off-peak-ticket-expired",
    isOffPeakTicketExpiredError: () => false,
  },
);
const mediaCodes = {
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE: "fixture-attachment-too-large",
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE: "fixture-image-too-large",
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE: "fixture-video-too-large",
};
const bannerFunctions = evaluateDeclarations(
  bannerSource,
  [
    "HISTORICAL_MODEL_UNAVAILABLE_MESSAGES",
    "LOCALIZED_ERROR_CODES",
    "MODEL_CONFIG_MISSING_CODES",
    "isModelConfigMissingError",
    "parseClaudeUnknownCommandMessage",
    "resolveChatErrorBannerDisplayMessage",
    "shouldSuppressChatErrorBanner",
    "buildErrorCopyText",
  ],
  {
    ...providerFunctions,
    ...mediaCodes,
    getRemoteConnectionFailureCode: () => undefined,
    formatRemoteConnectionError: () => {
      throw new Error("Local provider errors must not enter remote connection formatting");
    },
  },
);

for (const code of ["1005", "1006", "3008", "3010", "1308", "429"]) {
  test("chat banner preserves current provider error " + code + " message/detail/trace", () => {
    for (const locale of ["en-US", "zh-CN"]) {
      const error = Object.freeze({
        code,
        message: "Fixture provider limit reached",
        detail: "Fixture safe error detail",
        traceId: "local-fixture-trace",
      });
      const calls = [];
      const message = bannerFunctions.resolveChatErrorBannerDisplayMessage(error, {
        formatMessage: ({ id }) => {
          calls.push(id);
          return id;
        },
      });
      assert.equal(message, error.message, locale + ": current provider message must survive");
      assert.deepEqual(calls, [], "Current provider errors must not use retired official i18n");
      assert.equal(bannerFunctions.shouldSuppressChatErrorBanner(error), false);
      const copied = bannerFunctions.buildErrorCopyText({
        message,
        detail: error.detail,
        traceId: error.traceId,
        formatMessage: (id, values) => (values?.traceId ? id + ": " + values.traceId : id),
      });
      for (const value of [error.message, error.detail, error.traceId]) {
        assert.ok(copied.includes(value), "Copy must retain the current error field: " + value);
      }
    }
  });
}

test("chat banner no longer imports retired provider business message rewrites", () => {
  const imports = bannerSource.statements
    .filter(ts.isImportDeclaration)
    .map((node) => node.getText(bannerSource))
    .join("\n");
  assert.doesNotMatch(
    imports,
    /resolveOffPeakTicketExpiredBusinessCode|getProviderBusinessErrorMessageId/,
  );
});

test("chat banner retains owner/media/model/CLAUDE/suspicious-empty localization", () => {
  const cases = [
    ...[
      "TASK_OWNED_BY_OTHER_HOST",
      "STALE_TASK_OWNER_COMMAND",
      "NO_ACTIVE_TASK_OWNER",
      "OWNER_COMMAND_FAILED",
      ...Object.values(mediaCodes),
      "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
    ].map((code) => [{ code, message: "Fixture local error" }, "zcode.error." + code]),
    ...["model_config_missing", "MODEL_CONFIG_MISSING", "ModelConfigMissing"].flatMap((code) => [
      [{ code, message: "Fixture model config missing" }, "chat.error.noAvailableModel", "local"],
      [
        { code, message: "Fixture model config missing" },
        "chat.error.remoteNoAvailableModel",
        "remote",
      ],
    ]),
    [
      { code: "CLAUDE_UNKNOWN_COMMAND", message: "Claude Code 未知命令 /fixture。" },
      "zcode.error.CLAUDE_UNKNOWN_COMMAND",
      "local",
      { command: "/fixture" },
    ],
    [
      {
        code: "CLAUDE_UNKNOWN_COMMAND",
        message: "Claude Code 未知命令 /fixture（参数：safe args）。",
      },
      "zcode.error.CLAUDE_UNKNOWN_COMMAND_WITH_ARGS",
      "local",
      { command: "/fixture", args: "safe args" },
    ],
    [
      { code: "UNKNOWN", message: providerFunctions.SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE },
      "zcode.error.modelSuspiciousEmpty",
    ],
  ];
  for (const [error, expected, target = "local", values] of cases) {
    const calls = [];
    const message = bannerFunctions.resolveChatErrorBannerDisplayMessage(
      error,
      {
        formatMessage: (descriptor, actualValues) => {
          calls.push([descriptor.id, actualValues]);
          return descriptor.id;
        },
      },
      target,
    );
    assert.equal(message, expected, error.code + ": existing local formatting must survive");
    assert.deepEqual(calls, [[expected, values]]);
  }
});
