import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";

const helperText = await readFile(
  new URL(
    "../../packages/desktop/test/e2e/helpers/native-context-compression/ui.ts",
    import.meta.url,
  ),
  "utf8",
);
const helperSource = ts.createSourceFile("ui.ts", helperText, ts.ScriptTarget.Latest, true);
const functionNames = new Set(["closeNativeContextDetails", "openNativeContextDetails"]);
const helperNodes = helperSource.statements.filter(
  (node) =>
    (ts.isFunctionDeclaration(node) && functionNames.has(node.name?.text)) ||
    (ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === "nativeContextElement",
      )),
);
assert.equal(helperNodes.length, 3, "Execute both real helpers and their real element lookup");
const compiled = ts.transpileModule(
  helperNodes.map((node) => node.getText(helperSource)).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;
const loadHelpers = new Function("$", "browser", "exports", compiled);
const sourceSha256 = createHash("sha256").update(helperText).digest("hex");

const mobileHelperText = await readFile(
  new URL(
    "../../packages/desktop/test/e2e/helpers/native-context-compression/mobile.ts",
    import.meta.url,
  ),
  "utf8",
);
const mobileHelperSource = ts.createSourceFile(
  "mobile.ts",
  mobileHelperText,
  ts.ScriptTarget.Latest,
  true,
);
const mobileHelperNode = mobileHelperSource.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "closeNativeContextMobileDetails",
);
assert.ok(
  mobileHelperNode,
  "Execute the real mobile close helper through its controlled Page port",
);
const mobileHelpers = {};
new Function(
  "exports",
  ts.transpileModule(mobileHelperNode.getText(mobileHelperSource), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText,
)(mobileHelpers);
const mobileSourceSha256 = createHash("sha256").update(mobileHelperText).digest("hex");

function gate() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture({ details, popover }) {
  const dom = new JSDOM('<button data-testid="native-context-entry">entry</button>');
  const document = dom.window.document;
  const trace = [];
  const pendingClose = new Set();
  const unmounted = new Map(["details", "popover"].map((id) => [id, gate()]));
  const observedWait = new Map(["details", "popover"].map((id) => [id, gate()]));
  const afterCloseBoundary = gate();
  const selector = (id) => `[data-testid="native-context-${id}"]`;
  const element = (id) => document.querySelector(selector(id));
  let closeReturns = 0;
  let settled;

  function mountPortal(id) {
    const portal = document.createElement("section");
    portal.setAttribute("data-testid", `native-context-${id}`);
    const controls =
      id === "popover"
        ? ["open-parameters", "open-trends"]
        : ["tab-overview", "tab-trends", "tab-records", "tab-parameters"];
    for (const control of controls) {
      const button = document.createElement("button");
      button.setAttribute("data-testid", `native-context-${control}`);
      portal.append(button);
    }
    if (id === "details") {
      const closeButton = document.createElement("button");
      closeButton.setAttribute("data-slot", "dialog-close");
      portal.append(closeButton);
    }
    document.body.append(portal);
  }

  if (details) mountPortal("details");
  if (popover) mountPortal("popover");

  function commitUnmount(id) {
    element(id)?.remove();
    pendingClose.delete(id);
    unmounted.get(id).resolve();
    trace.push({ kind: "unmount", id });
  }

  const lookup = (query) => {
    const node = document.querySelector(query);
    const id = query.match(/native-context-([^"\]]+)/u)?.[1];
    return {
      async isDisplayed() {
        return Boolean(node?.isConnected && !node.hidden);
      },
      async waitForDisplayed({ reverse = false } = {}) {
        trace.push({ kind: reverse ? "wait-close" : "wait-open", id });
        if (!reverse) {
          assert.ok(
            node?.isConnected && !node.hidden,
            "The real open helper must create its portal",
          );
          return;
        }
        observedWait.get(id)?.resolve();
        if (id === "popover") afterCloseBoundary.resolve("popover.wait");
        // 原因：驱动收到 Escape 与 React portal 卸载是不同边界；只由显式 DOM 提交解除关闭观察。
        if (node?.isConnected) await unmounted.get(id).promise;
        assert.equal(node?.isConnected ?? false, false, "The closing portal must actually be gone");
      },
      async click() {
        trace.push({ kind: "click", id });
        assert.ok(node?.isConnected, "A stale portal control cannot receive the next real click");
        if (id === "entry") {
          assert.equal(element("popover"), null, "Opening starts after the old Popover is gone");
          mountPortal("popover");
        } else if (id === "open-parameters" || id === "open-trends") {
          assert.equal(pendingClose.has("popover"), false, "Do not reopen a closing Popover");
          mountPortal("details");
        }
      },
    };
  };
  const browser = {
    async keys(key) {
      assert.equal(key, "Escape");
      const id = element("details") ? "details" : element("popover") ? "popover" : null;
      assert.ok(id, "An absent portal must not receive an extra Escape");
      trace.push({ kind: "escape", id });
      pendingClose.add(id);
      // 键盘协议已经完成，DOM 故意仍保留；测试不得靠 sleep 让这两个事实偶然同步。
    },
  };
  const source = {};
  loadHelpers(lookup, browser, source);
  const page = {
    getByTestId(testId) {
      const query = `[data-testid="${testId}"]`;
      const id = testId.replace(/^native-context-/u, "");
      return {
        isVisible: () => lookup(query).isDisplayed(),
        locator(childQuery) {
          return {
            async click() {
              assert.ok(document.querySelector(`${query} ${childQuery}`)?.isConnected);
              trace.push({ kind: "close-button", id });
              pendingClose.add(id);
            },
          };
        },
        async waitFor({ state }) {
          assert.equal(state, "hidden", "The mobile helper must observe the real hidden boundary");
          afterCloseBoundary.resolve(`${id}.wait`);
          // 原因：close 按钮或 Escape 回包后模态层仍可能遮住背景导航；复用同一个 DOM 卸载 gate。
          await lookup(query).waitForDisplayed({ reverse: true });
        },
      };
    },
    keyboard: { press: (key) => browser.keys(key) },
  };

  function startMobileClose() {
    assert.equal(settled, undefined, "One mobile closing transaction is sufficient");
    settled = mobileHelpers.closeNativeContextMobileDetails(page).then(
      () => {
        closeReturns++;
        trace.push({ kind: "close-return" });
        afterCloseBoundary.resolve("close.returned");
        return { completed: true };
      },
      (error) => {
        afterCloseBoundary.resolve("failed");
        return { completed: false, error };
      },
    );
  }

  function startCloseAndReopen() {
    assert.equal(settled, undefined, "One closing transaction and one reopening are sufficient");
    const completion = (async () => {
      await source.closeNativeContextDetails();
      closeReturns++;
      trace.push({ kind: "close-return" });
      afterCloseBoundary.resolve("close.returned");
      await source.openNativeContextDetails("parameters");
    })();
    settled = completion.then(
      () => ({ completed: true }),
      (error) => {
        afterCloseBoundary.resolve("failed");
        for (const signal of observedWait.values()) signal.resolve();
        return { completed: false, error };
      },
    );
  }

  async function complete() {
    const result = await settled;
    if (!result.completed) throw result.error;
  }

  async function dispose() {
    for (const id of unmounted.keys()) commitUnmount(id);
    if (settled) await settled;
    dom.window.close();
  }

  return {
    trace,
    element,
    commitUnmount,
    startCloseAndReopen,
    startMobileClose,
    closeMobile: () => mobileHelpers.closeNativeContextMobileDetails(page),
    complete,
    dispose,
    waited: (id) => observedWait.get(id).promise,
    closeBoundary: afterCloseBoundary.promise,
    closeReturns: () => closeReturns,
  };
}

function assertOneReopen(f) {
  assert.equal(f.closeReturns(), 1);
  for (const id of ["entry", "open-parameters", "tab-parameters"])
    assert.equal(
      f.trace.filter((event) => event.kind === "click" && event.id === id).length,
      1,
      "Exactly one real opening click for " + id,
    );
  assert.ok(f.element("details")?.isConnected);
}

test("actual close waits for Popover portal unmount before returning or opening parameters once", async (t) => {
  t.diagnostic("actual ui.ts SHA256: " + sourceSha256);
  const f = fixture({ details: false, popover: true });
  t.after(() => f.dispose());
  f.startCloseAndReopen();
  assert.equal(
    await f.closeBoundary,
    "popover.wait",
    "closeNativeContextDetails returned before observing the closing Popover",
  );
  assert.ok(f.element("popover")?.isConnected);
  assert.equal(f.closeReturns(), 0);
  assert.equal(f.trace.filter((event) => event.kind === "click").length, 0);
  f.commitUnmount("popover");
  await f.complete();
  assert.deepEqual(
    f.trace.filter((event) => event.kind === "escape").map((event) => event.id),
    ["popover"],
  );
  assertOneReopen(f);
});

test("actual close observes details then Popover and cannot pass either unmount gate early", async (t) => {
  const f = fixture({ details: true, popover: true });
  t.after(() => f.dispose());
  f.startCloseAndReopen();
  await f.waited("details");
  assert.ok(f.element("details")?.isConnected);
  assert.equal(f.closeReturns(), 0);
  assert.deepEqual(
    f.trace.filter((event) => event.kind === "escape").map((event) => event.id),
    ["details"],
  );
  f.commitUnmount("details");
  assert.equal(
    await f.closeBoundary,
    "popover.wait",
    "The second Escape must also be followed by an observed Popover close",
  );
  assert.ok(f.element("popover")?.isConnected);
  assert.equal(f.closeReturns(), 0);
  assert.equal(f.trace.filter((event) => event.kind === "click").length, 0);
  f.commitUnmount("popover");
  await f.complete();
  assert.deepEqual(
    f.trace.filter((event) => event.kind === "wait-close").map((event) => event.id),
    ["details", "popover"],
  );
  assertOneReopen(f);
});

test("an absent Popover adds no Escape or close wait after the actual details close", async (t) => {
  const f = fixture({ details: true, popover: false });
  t.after(() => f.dispose());
  f.startCloseAndReopen();
  await f.waited("details");
  f.commitUnmount("details");
  await f.complete();
  assert.deepEqual(
    f.trace.filter((event) => event.kind === "escape").map((event) => event.id),
    ["details"],
  );
  assert.deepEqual(
    f.trace.filter((event) => event.kind === "wait-close").map((event) => event.id),
    ["details"],
  );
  assertOneReopen(f);
});

for (const [portal, trigger] of [
  ["details", "close-button"],
  ["popover", "escape"],
]) {
  test(`actual mobile ${portal} waits for hidden after ${trigger}, then closing is idempotent`, async (t) => {
    t.diagnostic("actual mobile.ts SHA256: " + mobileSourceSha256);
    const f = fixture({ details: portal === "details", popover: portal === "popover" });
    t.after(() => f.dispose());
    f.startMobileClose();
    assert.equal(
      await f.closeBoundary,
      `${portal}.wait`,
      "The real mobile helper returned before observing its closing portal",
    );
    assert.ok(f.element(portal)?.isConnected);
    assert.equal(f.closeReturns(), 0, "No return while the modal still covers the background");
    assert.deepEqual(
      f.trace
        .filter((event) => event.kind === "close-button" || event.kind === "escape")
        .map(({ kind, id }) => ({ kind, id })),
      [{ kind: trigger, id: portal }],
    );
    f.commitUnmount(portal);
    await f.complete();
    assert.equal(f.closeReturns(), 1);
    const completedTrace = [...f.trace];
    await f.closeMobile();
    assert.deepEqual(
      completedTrace,
      f.trace,
      "Already closed: no extra click, Escape or hidden wait",
    );
  });
}
