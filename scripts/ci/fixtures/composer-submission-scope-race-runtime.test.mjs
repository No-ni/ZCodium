import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { projectRoot, assertProjectPath } from "../project-test-sandbox.mjs";

await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT ?? "");
const { JSDOM } = await import("jsdom");
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://composer-scope-fixture.invalid/",
});
const globals = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"];
const originalGlobals = new Map(
  globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const key of globals)
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[key],
  });
const React = await import("react");
const { act, createElement } = React;
const reactPorts = Object.fromEntries(
  Object.entries(React).filter(([name]) => /^use[A-Z]|^createElement$/.test(name)),
);
const { createRoot } = await import("react-dom/client");

async function source(path) {
  const text = await readFile(join(projectRoot, path), "utf8");
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function names(node) {
  const result = new Set();
  function visit(current) {
    if (ts.isIdentifier(current)) result.add(current.text);
    ts.forEachChild(current, visit);
  }
  visit(node);
  return result;
}
function declaredNames(node) {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isArrayBindingPattern(node) || ts.isObjectBindingPattern(node))
    return node.elements.flatMap((item) =>
      ts.isBindingElement(item) ? declaredNames(item.name) : [],
    );
  return [];
}
function evaluate(text, dependencies, result) {
  const { outputText } = ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
    },
  });
  return new Function(...Object.keys(dependencies), `${outputText}\nreturn ${result};`)(
    ...Object.values(dependencies),
  );
}

// 使用当前 CLI 的真实 held-queue 裁决生成拒绝，绝不手工制造 stale ACK。
const admissionAst = await source(
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/input-admission.ts",
);
const admissionNames = [
  "V4HeldQueueDispositionRequiredError",
  "V4HeldQueueConfirmationStaleError",
  "applyHeldQueueDisposition",
];
const admissionDefinitions = admissionAst.statements.filter((statement) =>
  admissionNames.includes(statement.name?.text),
);
assert.equal(admissionDefinitions.length, 3);
const { applyHeldQueueDisposition } = evaluate(
  admissionDefinitions
    .map((node) => node.getText(admissionAst).replace(/^export\s+/, ""))
    .join("\n"),
  {},
  "({ applyHeldQueueDisposition })",
);

const paneAst = await source("packages/ui/src/v4/SessionPane.tsx");
const paneCallbacks = new Map();
const paneCallbackHooks = new Map();
let paneErrorState;
let paneScopeTokenRef;
let paneScopeTokenMirror;
let paneErrorReset;
function findPaneCallback(node) {
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    if (declaredNames(declaration.name).includes("sendSubmissionError"))
      paneErrorState = node.getText(paneAst);
    if (declaration.name.getText(paneAst) === "composerDraftScopeTokenRef")
      paneScopeTokenRef = node.getText(paneAst);
  }
  if (
    ts.isExpressionStatement(node) &&
    node.getText(paneAst).match(/^composerDraftScopeTokenRef\.current\s*=/)
  )
    paneScopeTokenMirror = node.getText(paneAst);
  if (
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(paneAst) === "useEffect" &&
    node.expression.arguments[0].getText(paneAst).includes("setSendSubmissionError(null)") &&
    node.expression.arguments[1]?.getText(paneAst) === "[sessionId]"
  )
    paneErrorReset = node.getText(paneAst);
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    ["dispatchSendTextAfterConfig", "handleSendText", "focusTimelineToLatest"].includes(
      node.name.text,
    )
  ) {
    assert.ok(
      ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(paneAst) === "useCallback",
    );
    paneCallbacks.set(node.name.text, node.initializer.arguments[0].getText(paneAst));
    paneCallbackHooks.set(node.name.text, node.initializer.getText(paneAst));
  }
  ts.forEachChild(node, findPaneCallback);
}
findPaneCallback(paneAst);
assert.equal(paneCallbacks.size, 3);
assert.ok(paneErrorState && paneErrorReset);
assert.equal(Boolean(paneScopeTokenRef), Boolean(paneScopeTokenMirror));
function paneCallback(name, dependencies) {
  return evaluate(`const callback = ${paneCallbacks.get(name)};`, dependencies, "callback");
}
const draftControlAst = await source("packages/ui/src/v4/composer/useDraftConfigControl.ts");
let transactionSource;
function findTransaction(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(draftControlAst) === "captureComposerSubmissionDraftTransaction"
  )
    transactionSource = node.initializer.arguments[0].getText(draftControlAst);
  ts.forEachChild(node, findTransaction);
}
findTransaction(draftControlAst);
assert.ok(transactionSource);
let composerKey;
function findComposer(node) {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    if (node.tagName.getText(paneAst) === "ConversationComposer")
      composerKey = node.attributes.properties.find(
        (attr) => ts.isJsxAttribute(attr) && attr.name.getText(paneAst) === "key",
      )?.initializer;
  }
  ts.forEachChild(node, findComposer);
}
findComposer(paneAst);
assert.ok(
  composerKey && ts.isStringLiteral(composerKey),
  "生产 Composer 必须仍使用跨会话固定 key，此回归才证明原地竞态",
);

const composerAst = await source("packages/ui/src/v4/ConversationComposer.tsx");
const composerFunction = composerAst.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "ConversationComposerImpl",
);
assert.ok(composerFunction?.body);
let confirmationOpenChange;
function findConfirmationCallback(node) {
  if (
    ts.isJsxOpeningElement(node) &&
    node.tagName.getText(composerAst) === "Dialog" &&
    node.attributes.getText(composerAst).includes("heldQueueConfirmation")
  ) {
    const attr = node.attributes.properties.find(
      (property) =>
        ts.isJsxAttribute(property) && property.name.getText(composerAst) === "onOpenChange",
    );
    confirmationOpenChange = attr.initializer.expression.getText(composerAst);
  }
  ts.forEachChild(node, findConfirmationCallback);
}
findConfirmationCallback(composerFunction);
assert.ok(confirmationOpenChange);
const variables = new Map();
for (const statement of composerFunction.body.statements) {
  if (ts.isVariableStatement(statement))
    for (const declaration of statement.declarationList.declarations)
      for (const name of declaredNames(declaration.name)) variables.set(name, statement);
}

const selection = Object.freeze({ providerId: "fixture-provider", modelId: "fixture-model" });
const noop = () => {};
const boundaryNames = new Set([
  ...Object.keys(React),
  "ports",
  "sessionId",
  "snapshot",
  "workspacePath",
  "workspaceIdentity",
  "composerDraft",
  "composerDraftScopeToken",
  "draftMode",
  "disabled",
  "submissionReady",
  "createSubmissionFromComposer",
  "draftConfig",
  "modelSelectionView",
  "provider",
  "onTextChange",
  "onDraftStateChange",
  "updateComposerContent",
  "replaceComposerDraft",
  "attachmentsApi",
  "webElementContexts",
  "pluginUiContexts",
  "pptxElementReferences",
  "conversationSelectionReferences",
  "pendingShareContext",
  "hasAttachments",
  "hasCodeCommentContexts",
  "hasWebElementContexts",
  "hasPptxElementReferences",
  "hasConversationSelectionReferences",
  "hasPluginUiContexts",
  "getCodeCommentContexts",
  "getLocalTtftObserver",
  "advanceComposerDraftRevision",
  "V4_DRAFT_SCOPE_ROOT",
  "consumeV4ComposerDraftWorkspaceTransferRequest",
  "restorePersistedComposerDraftIntoInput",
  "requestComposerFocus",
  "persistDraftNow",
  "scheduleDraftPersist",
  "onSendText",
  "serializeComposerPromptContexts",
  "countComposerPromptContexts",
  "readPromptHistoryEntries",
  "appendPromptHistoryEntry",
  "arePromptHistoryEntriesEqual",
  "persistPromptHistoryEntries",
  "setPromptHistory",
  "removeCodeCommentContext",
  "removeWebElementContext",
  "removePluginUiContext",
  "removePptxElementReference",
  "removeConversationSelectionReference",
  "logger",
  "captureComposerSubmissionDraftTransaction",
  "stageComposerContent",
  "persistComposerContent",
  "captureComposerContentLifecycleCommit",
]);
const selected = new Set();
const required = [
  "text",
  "pending",
  "heldQueueConfirmation",
  "snapshotRef",
  "inputApiRef",
  "draftTargetRef",
  "ownerDraftRef",
  "submit",
  "handleEditorChange",
  "handleClearQueueSend",
  "handleKeepQueueSend",
  "canSend",
  "showStopControl",
];
for (const name of required) {
  assert.ok(variables.has(name), `生产根表达式仍存在: ${name}`);
  selected.add(variables.get(name));
}
// 只回放 Composer 提交和 scope 的现有表达式；组件树、附件 IO 与布局是内存 ports。
let changed = true;
while (changed) {
  changed = false;
  for (const statement of selected)
    for (const name of names(statement)) {
      if (!boundaryNames.has(name) && variables.has(name) && !selected.has(variables.get(name))) {
        selected.add(variables.get(name));
        changed = true;
      }
    }
  const ownedNames = new Set(
    [...selected].flatMap((statement) =>
      ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.flatMap((declaration) =>
            declaredNames(declaration.name),
          )
        : [],
    ),
  );
  for (const statement of composerFunction.body.statements) {
    if (selected.has(statement)) continue;
    const references = names(statement);
    const relevantEffect =
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      statement.expression.expression.getText(composerAst) === "useEffect" &&
      ([...references].some(
        (name) =>
          /draftTargetRef|pendingRef|setPending|setHeldQueueConfirmation|ScopeToken/.test(name) &&
          (ownedNames.has(name) || name === "composerDraftScopeToken"),
      ) ||
        /ownerDraftRef\.current\s*=/.test(statement.getText(composerAst)));
    const relevantRenderAssignment =
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      [...references].some((name) => ownedNames.has(name));
    const relevantRenderGuard =
      ts.isIfStatement(statement) &&
      [...names(statement.expression)].some(
        (name) => /pending|Pending|ScopeToken/.test(name) && ownedNames.has(name),
      );
    if (relevantEffect || relevantRenderAssignment || relevantRenderGuard) {
      selected.add(statement);
      changed = true;
    }
  }
}
const selectedSource = composerFunction.body.statements
  .filter((statement) => selected.has(statement))
  .map((statement) => statement.getText(composerAst))
  .join("\n");
const param = `{ ${composerFunction.parameters[0].name.elements.map((element) => `${element.propertyName ? `${element.propertyName.getText(composerAst)}: ` : ""}${element.name.getText(composerAst)}`).join(", ")} }`;
const ComposerProbe = evaluate(
  `function ComposerProbe(${param}) {
  const ports = arguments[0].ports;
  const mountIdentity = useRef(Symbol("mounted composer"));
  const { attachmentsApi, hasAttachments, hasCodeCommentContexts, hasWebElementContexts, hasPptxElementReferences, hasConversationSelectionReferences, hasPluginUiContexts, webElementContexts, pluginUiContexts, pptxElementReferences, conversationSelectionReferences, pendingShareContext, getCodeCommentContexts, requestComposerFocus, persistDraftNow, scheduleDraftPersist } = ports;
  ${selectedSource}
  inputApiRef.current = ports.inputApi;
  ports.current = { submit, handleEditorChange, handleClearQueueSend, handleKeepQueueSend, onConfirmationOpenChange: ${confirmationOpenChange}, pending, heldQueueConfirmation, text, canSend, showStopControl, mountIdentity: mountIdentity.current };
  return createElement("div", { "data-pending": String(pending), "data-confirmation": String(heldQueueConfirmation !== null), "data-can-send": String(canSend), "data-stop": String(showStopControl), "data-text": text });
}`,
  {
    ...reactPorts,
    advanceComposerDraftRevision: noop,
    getLocalTtftObserver: () => undefined,
    V4_DRAFT_SCOPE_ROOT: "__draft__",
    consumeV4ComposerDraftWorkspaceTransferRequest: () => false,
    restorePersistedComposerDraftIntoInput: ({ draft, inputApi }) => {
      inputApi.setText(draft.text);
      return draft.text;
    },
    serializeComposerPromptContexts: (text) => text,
    countComposerPromptContexts: () => 0,
    readPromptHistoryEntries: () => [],
    appendPromptHistoryEntry: (before, text) => [...before, text],
    arePromptHistoryEntriesEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    persistPromptHistoryEntries: noop,
    setPromptHistory: noop,
    removeCodeCommentContext: noop,
    removeWebElementContext: noop,
    removePluginUiContext: noop,
    removePptxElementReference: noop,
    removeConversationSelectionReference: noop,
    logger: { warn: noop },
  },
  "ComposerProbe",
);

const focusPolicyAst = await source("packages/ui/src/v4/promptScrollFocusPolicy.ts");
const focusPolicy = focusPolicyAst.statements.find(
  (statement) => statement.name?.text === "shouldFocusTimelineAfterComposerSend",
);
assert.ok(focusPolicy);
const shouldFocusTimelineAfterComposerSend = evaluate(
  focusPolicy.getText(focusPolicyAst).replace(/^export\s+/, ""),
  {},
  "shouldFocusTimelineAfterComposerSend",
);
// 错误状态、会话切换清错及异步尾部都执行当前 Pane 的真实 hooks；时间线只替换 IO port。
const PaneProbe = evaluate(
  `function PaneProbe(props) {
    const { sessionId, composerDraftScopeToken, dispatchSendText, ports, paneSnapshotRef } = props;
    const snapshotRef = paneSnapshotRef;
    const timelineScrollToBottomRef = useRef(null);
    timelineScrollToBottomRef.current = () => ports.scrolls.push({ sessionId, scopeToken: composerDraftScopeToken });
    const intl = useMemo(() => ({ formatMessage: () => "Fixture send failed" }), []);
    ${paneErrorState}
    ${paneScopeTokenRef ?? ""}
    ${paneScopeTokenMirror ?? ""}
    const focusTimelineToLatest = ${paneCallbackHooks.get("focusTimelineToLatest")};
    const handleSendText = ${paneCallbackHooks.get("handleSendText")};
    ${paneErrorReset}
    ports.paneCurrent = { sendSubmissionError };
    return createElement(ComposerProbe, { ...props, onSendText: handleSendText });
  }`,
  { ...reactPorts, ComposerProbe, shouldFocusTimelineAfterComposerSend },
  "PaneProbe",
);

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let root;
let rafs = [];
globalThis.requestAnimationFrame = (fn) => {
  rafs.push(fn);
  return rafs.length;
};
globalThis.cancelAnimationFrame = (id) => {
  rafs[id - 1] = null;
};
async function flushFrames() {
  await act(() => {
    const queued = rafs;
    rafs = [];
    for (const fn of queued) fn?.();
  });
}
async function harness() {
  const drafts = new Map();
  const requests = [];
  const ports = {
    current: null,
    paneCurrent: null,
    scrolls: [],
    inputApi: {
      text: "",
      getEditorState: () => null,
      setText(text) {
        this.text = text;
      },
      clear() {
        this.text = "";
      },
      setEditorStateJson(text) {
        this.text = text;
      },
    },
    attachmentsApi: {
      attachments: [],
      hasUnreadyAttachments: false,
      prepareForSend: async () => [],
      adoptSentAttachments: async () => {},
      clearAttachments: noop,
    },
    hasAttachments: false,
    hasCodeCommentContexts: false,
    hasWebElementContexts: false,
    hasPptxElementReferences: false,
    hasConversationSelectionReferences: false,
    hasPluginUiContexts: false,
    webElementContexts: [],
    pluginUiContexts: [],
    pptxElementReferences: [],
    conversationSelectionReferences: [],
    pendingShareContext: null,
    getCodeCommentContexts: () => [],
    requestComposerFocus: noop,
    persistDraftNow: noop,
    scheduleDraftPersist: noop,
    createSubmissionFromComposer: () => ({
      modelSelection: selection,
      mode: "build",
      planEnabled: false,
    }),
  };
  let target;
  const paneSnapshotRef = { current: null };
  const ownerStateRef = { current: null };
  const stagedContentRef = { current: null };
  const cliQueues = new Map([
    ["a", ["a-one", "a-two"]],
    ["b", ["b-one"]],
    ["prewarm", []],
  ]);
  function props(sessionId, text, token = Symbol(sessionId)) {
    drafts.set(sessionId, text);
    const result = {
      sessionId,
      composerDraftScopeToken: token,
      workspacePath: "fixture-workspace",
      workspaceIdentity: "fixture-host",
      draftMode: sessionId === null,
      disabled: false,
      submissionReady: true,
      composerDraft: { text, updatedAt: 0 },
      draftConfig: {},
      modelSelectionView: {},
      provider: "fixture-provider",
      ports,
      createSubmissionFromComposer: ports.createSubmissionFromComposer,
      snapshot: {
        sessionId,
        control: { canStop: true, phase: "running" },
        config: {},
        queue: {
          items: (sessionId === "a" ? ["a-one"] : ["b-one"]).map((queueItemId) => ({
            queueItemId,
          })),
        },
        inputRouting: { mode: "choice" },
      },
    };
    if (sessionId === null) {
      result.snapshot.inputRouting.mode = "startNow";
      result.snapshot.queue.items = [];
    }
    const persistenceTarget = {
      scopeKey: sessionId,
      incarnation: token,
      contentRevision: { current: 0 },
      baseDraft: result.composerDraft,
      persist(draft) {
        drafts.set(sessionId, draft.text);
        return true;
      },
    };
    ownerStateRef.current = { incarnation: token, draft: result.composerDraft };
    result.updateComposerContent = (content) => {
      if (ownerStateRef.current.incarnation !== token) return;
      const draft = { ...ownerStateRef.current.draft, ...content };
      persistenceTarget.baseDraft = draft;
      persistenceTarget.contentRevision.current += 1;
      ownerStateRef.current = { ...ownerStateRef.current, draft };
      persistenceTarget.persist(draft);
    };
    result.replaceComposerDraft = result.updateComposerContent;
    result.captureComposerSubmissionDraftTransaction = evaluate(
      `const callback = ${transactionSource};`,
      {
        scopePersistenceTarget: persistenceTarget,
        mountedRef: { current: true },
        stateRef: ownerStateRef,
        stagedContentRef,
        bumpScopeContentRevision: (value) => {
          value.contentRevision.current += 1;
        },
        setStoredState: (state) => {
          persistenceTarget.persist(state.draft);
        },
      },
      "callback",
    );
    const runtimeSessionId = sessionId ?? "prewarm";
    const prewarmBinding = { sessionId: "prewarm", beginPromotion: () => true, promote: noop };
    const dispatchCommand = async (_type, payload, targetSessionId) => {
      assert.equal(targetSessionId, runtimeSessionId);
      const gate = deferred();
      const request = { sessionId, prompt: payload.text, options: payload, gate, started: true };
      requests.push(request);
      await gate.promise;
      // 当前 V4 handler 使用的相同裁决：不一致的已确认 queue ids 产生真实 stale rejection。
      const record = {
        app: {
          sessionId: runtimeSessionId,
          clearQueueItems: async () => cliQueues.set(runtimeSessionId, []),
        },
      };
      try {
        await applyHeldQueueDisposition(
          {
            getInputRoutingMode: () => (sessionId === null ? "startNow" : "choice"),
            getQueueLength: () => cliQueues.get(runtimeSessionId).length,
            getQueueItem: (_id, queueItemId) =>
              cliQueues.get(runtimeSessionId).includes(queueItemId) ? { queueItemId } : null,
          },
          record,
          payload.heldQueueDisposition,
          payload.expectedHeldQueueItemIds,
        );
        return { status: "accepted" };
      } catch (error) {
        request.rejection = error.reasonCode;
        if (error.reasonCode === "guard.heldQueueConfirmationStale")
          return { status: "rejected", reasonCode: error.reasonCode };
        throw error;
      }
    };
    const dispatchAfterConfig = paneCallback("dispatchSendTextAfterConfig", {
      parseV4VisibleSlashCommand: () => null,
      ensureDraftModelReadyForSend: async () => true,
      appSlashCommands: [],
      sessionId,
      snapshotRef: paneSnapshotRef,
      dispatchCommand,
      settleCurrentQueueInputs: noop,
      prewarmBindingRef: { current: prewarmBinding },
      ensureDraftPrewarmConfigBeforeSendRef: { current: async () => {} },
      // 本回放仅抛普通 transport Error；provider 分类及日志为既有边界 ports。
      isProviderNotReadyError: () => false,
      logger: { warn: noop },
    });
    result.dispatchSendText = (text, options) =>
      dispatchAfterConfig(text, options, {}, prewarmBinding);
    result.paneSnapshotRef = paneSnapshotRef;
    return result;
  }
  async function render(sessionId, text = "", token) {
    target = props(sessionId, text, token);
    paneSnapshotRef.current = target.snapshot;
    root ??= createRoot(document.getElementById("root"));
    await act(() => root.render(createElement(PaneProbe, target)));
    await flushFrames();
    return ports.current;
  }
  async function send(...args) {
    let completion;
    await act(() => {
      completion = ports.current.submit(...args);
    });
    return { completion };
  }
  async function settle(request, rejection) {
    await act(async () => {
      if (rejection) request.gate.reject(rejection);
      else request.gate.resolve();
      await Promise.resolve();
    });
  }
  return {
    ports,
    requests,
    drafts,
    cliQueues,
    render,
    send,
    settle,
    get target() {
      return target;
    },
  };
}
afterEach(async () => {
  if (root) await act(() => root.unmount());
  root = null;
  rafs = [];
});
after(() => {
  dom.window.close();
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
  for (const [key, descriptor] of originalGlobals)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
});

test("同 scope 的真实 stale ACK 保留原文并展示对应暂停队列确认", async () => {
  const h = await harness();
  await h.render("a", "A submitted prompt");
  const send = await h.send("clearQueueAndSend", ["a-one"]);
  assert.equal(h.ports.current.pending, true);
  await h.settle(h.requests[0]);
  await send.completion;
  assert.equal(h.requests[0].rejection, "guard.heldQueueConfirmationStale");
  assert.equal(h.ports.current.pending, false);
  assert.equal(h.ports.current.heldQueueConfirmation !== null, true);
  assert.equal(h.ports.inputApi.text, "A submitted prompt");
});

test("A 等 ACK 时切到 B，旧提交不能阻止 B 自己发送", async () => {
  const h = await harness();
  await h.render("a", "A submitted prompt");
  const originalIdentity = h.ports.current.mountIdentity;
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.render("b", "B own prompt");
  assert.equal(h.ports.current.mountIdentity, originalIdentity);
  const pendingAtB = h.ports.current.pending;
  const canSendAtB = h.ports.current.canSend;
  await h.settle(h.requests[0]);
  await oldSend.completion;
  assert.equal(pendingAtB, false);
  assert.equal(canSendAtB, true);
});

test("A 的真实 stale ACK 迟到时不能在 B 打开确认或携带 A 正文", async () => {
  const h = await harness();
  await h.render("a", "A submitted prompt");
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.render("b", "B own prompt");
  await h.settle(h.requests[0]);
  await oldSend.completion;
  assert.equal(h.requests[0].rejection, "guard.heldQueueConfirmationStale");
  assert.equal(h.ports.current.heldQueueConfirmation, null);
  assert.equal(h.ports.inputApi.text, "B own prompt");
  assert.equal(h.drafts.get("a"), "A submitted prompt");
});

test("离开再回到相同 id 的新 scope 不能接收旧 incarnation 的 stale ACK", async () => {
  const h = await harness();
  const firstToken = Symbol("first a");
  await h.render("a", "A submitted prompt", firstToken);
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.render("b", "B own prompt");
  await h.render("a", "A newer draft", Symbol("new a"));
  await h.settle(h.requests[0]);
  await oldSend.completion;
  assert.equal(h.ports.current.heldQueueConfirmation, null);
  assert.equal(h.ports.inputApi.text, "A newer draft");
});

test("A 迟到成功和 finally 不能清除 B 在途提交的 pending", async () => {
  const h = await harness();
  h.cliQueues.set("a", ["a-one"]);
  await h.render("a", "A submitted prompt");
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.render("b", "B own prompt");
  const nextSend = await h.send("keepQueueAndSend", ["b-one"]);
  const bRequest = h.requests.find((request) => request.sessionId === "b");
  await h.settle(h.requests[0]);
  await oldSend.completion;
  const pendingAfterOldFinally = h.ports.current.pending;
  if (bRequest) {
    await h.settle(bRequest);
    await nextSend.completion;
  }
  assert.ok(bRequest, "B 必须能独立发出自己的提交");
  assert.equal(bRequest.prompt, "B own prompt");
  assert.equal(pendingAfterOldFinally, true);
});

test("B 已得到自己的确认后 A 的迟到成功不能清它", async () => {
  const h = await harness();
  h.cliQueues.set("a", ["a-one"]);
  h.cliQueues.set("b", ["b-one", "b-two"]);
  await h.render("a", "A submitted prompt");
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.render("b", "B own prompt");
  const nextSend = await h.send("keepQueueAndSend", ["b-one"]);
  const bRequest = h.requests.find((request) => request.sessionId === "b");
  if (bRequest) {
    await h.settle(bRequest);
    await nextSend.completion;
  }
  const bConfirmation = h.ports.current.heldQueueConfirmation;
  await h.settle(h.requests[0]);
  await oldSend.completion;
  assert.ok(bRequest, "B 必须先真正发出提交");
  assert.equal(bRequest.rejection, "guard.heldQueueConfirmationStale");
  assert.equal(h.ports.current.heldQueueConfirmation, bConfirmation);
  assert.ok(bConfirmation);
});

test("同 scope 等待期间的新编辑不能被旧 stale 回包恢复或重开确认", async () => {
  const h = await harness();
  await h.render("a", "A submitted prompt");
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await act(() => {
    h.ports.inputApi.setText("A later edit");
    h.ports.current.handleEditorChange("A later edit");
  });
  await h.settle(h.requests[0]);
  await oldSend.completion;
  assert.equal(h.requests[0].rejection, "guard.heldQueueConfirmationStale");
  assert.equal(h.ports.current.heldQueueConfirmation, null);
  assert.equal(h.ports.inputApi.text, "A later edit");
  assert.equal(h.drafts.get("a"), "A later edit");
});

test("旧 scope transport 拒绝恢复原 A 草稿而不污染运行中的空 B", async () => {
  const h = await harness();
  await h.render("a", "A submitted prompt");
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.render("b", "");
  await h.settle(h.requests[0], new Error("fixture transport rejection"));
  await oldSend.completion;
  assert.equal(h.drafts.get("a"), "A submitted prompt");
  assert.equal(h.ports.inputApi.text, "");
  assert.equal(h.ports.current.heldQueueConfirmation, null);
  assert.equal(h.ports.current.showStopControl, true);
});

test("同 scope pending 阻挡重复提交，accepted 仍清本次草稿", async () => {
  const h = await harness();
  h.cliQueues.set("a", ["a-one"]);
  await h.render("a", "A submitted prompt");
  const send = await h.send("clearQueueAndSend", ["a-one"]);
  await h.send("clearQueueAndSend", ["a-one"]);
  assert.equal(h.requests.length, 1);
  await h.settle(h.requests[0]);
  await send.completion;
  assert.equal(h.ports.current.pending, false);
  assert.equal(h.ports.inputApi.text, "");
  assert.equal(h.drafts.get("a"), "");
});

test("同 scope accepted 不能清除等待期间写入的下一条正文", async () => {
  const h = await harness();
  h.cliQueues.set("a", ["a-one"]);
  await h.render("a", "A submitted prompt");
  const send = await h.send("clearQueueAndSend", ["a-one"]);
  await act(() => {
    h.ports.inputApi.setText("A next prompt");
    h.ports.current.handleEditorChange("A next prompt");
  });
  await h.settle(h.requests[0]);
  await send.completion;
  assert.equal(h.ports.current.pending, false);
  assert.equal(h.ports.inputApi.text, "A next prompt");
  assert.equal(h.drafts.get("a"), "A next prompt");
});

test("Root prewarm 转正保留相同 token，首发 pending 和 accepted 正常收口", async () => {
  const h = await harness();
  const token = Symbol("root promotion");
  await h.render(null, "Root submitted prompt", token);
  const send = await h.send();
  assert.equal(h.requests.length, 1);
  await h.render("prewarm", "", token);
  assert.equal(h.ports.current.pending, true);
  await h.settle(h.requests[0]);
  await send.completion;
  assert.equal(h.requests[0].prompt, "Root submitted prompt");
  assert.equal(h.ports.current.pending, false);
  assert.equal(h.ports.current.heldQueueConfirmation, null);
  assert.equal(h.ports.inputApi.text, "");
});

test("A accepted 后等待附件 adopt，旧 finally 也不能清 B 的 pending", async () => {
  const h = await harness();
  h.cliQueues.set("a", ["a-one"]);
  const adopt = deferred();
  let calls = 0;
  h.ports.attachmentsApi.adoptSentAttachments = () =>
    ++calls === 1 ? adopt.promise : Promise.resolve();
  await h.render("a", "A submitted prompt");
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.settle(h.requests[0]);
  assert.equal(calls, 1);
  await h.render("b", "B own prompt");
  const nextSend = await h.send("keepQueueAndSend", ["b-one"]);
  assert.equal(h.requests.length, 2);
  await act(() => adopt.resolve());
  await oldSend.completion;
  assert.equal(h.ports.current.pending, true);
  await h.settle(h.requests[1]);
  await nextSend.completion;
  assert.equal(h.ports.current.pending, false);
});

test("旧 A 确认按钮回调不能从 live ref 取 B 正文再发给 A", async () => {
  const h = await harness();
  await h.render("a", "A submitted prompt");
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.settle(h.requests[0]);
  await oldSend.completion;
  const oldKeep = h.ports.current.handleKeepQueueSend;
  await h.render("b", "B own prompt");
  await act(() => oldKeep());
  const staleRequest = h.requests[1];
  if (staleRequest) await h.settle(staleRequest);
  assert.equal(h.requests.length, 1);
  assert.equal(h.ports.inputApi.text, "B own prompt");
});

test("旧 A Dialog close 回调不能关闭已经属于 B 的确认", async () => {
  const h = await harness();
  await h.render("a", "A submitted prompt");
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.settle(h.requests[0]);
  await oldSend.completion;
  const oldClose = h.ports.current.onConfirmationOpenChange;
  h.cliQueues.set("b", ["b-one", "b-two"]);
  await h.render("b", "B own prompt");
  const nextSend = await h.send("keepQueueAndSend", ["b-one"]);
  await h.settle(h.requests[1]);
  await nextSend.completion;
  const confirmation = h.ports.current.heldQueueConfirmation;
  assert.ok(confirmation);
  await act(() => oldClose(false));
  assert.equal(h.ports.current.heldQueueConfirmation, confirmation);
});

test("Pane 的旧 A 成功不能清除 B 的真实发送错误或滚动 B", async () => {
  const h = await harness();
  h.cliQueues.set("a", ["a-one"]);
  await h.render("a", "A submitted prompt");
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.render("b", "B own prompt");
  const nextSend = await h.send("keepQueueAndSend", ["b-one"]);
  await h.settle(h.requests[1], new Error("B current transport failure"));
  await nextSend.completion;
  const bError = h.ports.paneCurrent.sendSubmissionError;
  assert.equal(bError?.taskId, "b");
  assert.equal(bError?.detail, "B current transport failure");
  await h.settle(h.requests[0]);
  await oldSend.completion;
  assert.equal(h.ports.paneCurrent.sendSubmissionError, bError);
  assert.deepEqual(h.ports.scrolls, []);
});

test("Pane 的旧 A 失败不能覆盖 B 的真实发送错误", async () => {
  const h = await harness();
  await h.render("a", "A submitted prompt");
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.render("b", "B own prompt");
  const nextSend = await h.send("keepQueueAndSend", ["b-one"]);
  await h.settle(h.requests[1], new Error("B current transport failure"));
  await nextSend.completion;
  const bError = h.ports.paneCurrent.sendSubmissionError;
  await h.settle(h.requests[0], new Error("A late transport failure"));
  await oldSend.completion;
  assert.equal(h.ports.paneCurrent.sendSubmissionError, bError);
  assert.equal(h.drafts.get("a"), "A submitted prompt");
  assert.deepEqual(h.ports.scrolls, []);
});

test("Pane 的旧 A 成功不能滚动当前没有错误的 B 时间线", async () => {
  const h = await harness();
  h.cliQueues.set("a", ["a-one"]);
  await h.render("a", "A submitted prompt");
  const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.render("b", "B own prompt");
  await h.settle(h.requests[0]);
  await oldSend.completion;
  assert.equal(h.ports.paneCurrent.sendSubmissionError, null);
  assert.deepEqual(h.ports.scrolls, []);
});

for (const outcome of ["success", "failure"]) {
  test(`Pane A→B→A₂ 时旧 incarnation ${outcome} 不能修改新 A 的错误或时间线`, async () => {
    const h = await harness();
    h.cliQueues.set("a", ["a-one"]);
    const firstToken = Symbol("first a");
    const nextToken = Symbol("next a");
    await h.render("a", "A submitted prompt", firstToken);
    const oldSend = await h.send("clearQueueAndSend", ["a-one"]);
    await h.render("b", "B own prompt");
    await h.render("a", "A newer prompt", nextToken);
    const nextSend = await h.send("keepQueueAndSend", ["a-one"]);
    await h.settle(h.requests[1], new Error("New A current transport failure"));
    await nextSend.completion;
    const newError = h.ports.paneCurrent.sendSubmissionError;
    assert.equal(newError?.taskId, "a");
    assert.equal(newError?.detail, "New A current transport failure");
    await h.settle(
      h.requests[0],
      outcome === "failure" ? new Error("Old A late transport failure") : undefined,
    );
    await oldSend.completion;
    assert.equal(h.ports.paneCurrent.sendSubmissionError, newError);
    assert.equal(h.ports.inputApi.text, "A newer prompt");
    assert.deepEqual(h.ports.scrolls, []);
  });
}

test("Pane 当前 scope 失败仍展示错误，后续成功仍清错并滚动当前时间线", async () => {
  const h = await harness();
  h.cliQueues.set("a", ["a-one"]);
  const token = Symbol("current a");
  await h.render("a", "A submitted prompt", token);
  const failedSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.settle(h.requests[0], new Error("A current transport failure"));
  await failedSend.completion;
  assert.equal(h.ports.paneCurrent.sendSubmissionError?.code, "SEND_FAILED");
  assert.equal(h.ports.paneCurrent.sendSubmissionError?.detail, "A current transport failure");
  assert.equal(h.ports.paneCurrent.sendSubmissionError?.taskId, "a");
  assert.deepEqual(h.ports.scrolls, []);
  const successfulSend = await h.send("clearQueueAndSend", ["a-one"]);
  await h.settle(h.requests[1]);
  await successfulSend.completion;
  assert.equal(h.ports.paneCurrent.sendSubmissionError, null);
  assert.deepEqual(h.ports.scrolls, [{ sessionId: "a", scopeToken: token }]);
});

test("Pane Root 转正沿用 token，旧 Root 首发成功仍滚动正式时间线", async () => {
  const h = await harness();
  const token = Symbol("root promotion");
  await h.render(null, "Root submitted prompt", token);
  const send = await h.send();
  await h.render("prewarm", "", token);
  await h.settle(h.requests[0]);
  await send.completion;
  assert.equal(h.ports.paneCurrent.sendSubmissionError, null);
  assert.deepEqual(h.ports.scrolls, [{ sessionId: "prewarm", scopeToken: token }]);
});

test("Pane Root 转正沿用 token，旧 Root 首发失败仍展示当前生命周期错误", async () => {
  const h = await harness();
  const token = Symbol("root promotion");
  await h.render(null, "Root submitted prompt", token);
  const send = await h.send();
  await h.render("prewarm", "", token);
  await h.settle(h.requests[0], new Error("Root current transport failure"));
  await send.completion;
  assert.equal(h.ports.paneCurrent.sendSubmissionError?.detail, "Root current transport failure");
  assert.equal(h.ports.paneCurrent.sendSubmissionError?.code, "SEND_FAILED");
  assert.deepEqual(h.ports.scrolls, []);
});
