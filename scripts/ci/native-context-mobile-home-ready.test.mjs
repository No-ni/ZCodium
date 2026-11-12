import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";

const sourceText = await readFile(
  new URL("../../packages/desktop/test/e2e/helpers/web-remote-unread.ts", import.meta.url),
  "utf8",
);
const source = ts.createSourceFile(
  "web-remote-unread.ts",
  sourceText,
  ts.ScriptTarget.Latest,
  true,
);
const declarations = source.statements.filter(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "showMobileTaskHome",
);
assert.equal(declarations.length, 1, "Execute the single real showMobileTaskHome declaration");
const helpers = {};
new Function(
  "exports",
  ts.transpileModule(declarations[0].getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText,
)(helpers);
const sourceSha256 = createHash("sha256").update(sourceText).digest("hex");

function gate() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** 实际 DOM + 受控 Page/Locator 端口；不声称 Playwright 浏览器排版或导航已经验收。 */
function fixture() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const document = dom.window.document;
  const firstWait = gate();
  const pending = new Set();
  const trace = [];
  let navigationSettled = false;
  let clickCount = 0;
  let completed = false;
  let outcome;

  const visible = (node) => {
    if (!node?.isConnected) return false;
    for (let current = node; current; current = current.parentElement) {
      if (
        current.hidden ||
        current.style.display === "none" ||
        current.style.visibility === "hidden"
      )
        return false;
    }
    return true;
  };
  const unavailable = () =>
    Object.assign(new Error("Navigation never became visible"), {
      name: "TimeoutError",
      code: "NCTX_NAV_NOT_READY",
    });

  function observeDom() {
    for (const wait of pending) {
      if (wait.nodes().some(visible)) {
        pending.delete(wait);
        trace.push({ kind: "observed-visible", label: wait.label });
        wait.resolve();
      } else if (navigationSettled) {
        pending.delete(wait);
        wait.reject(unavailable());
      }
    }
  }
  const observer = new dom.window.MutationObserver(observeDom);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });

  function locator(nodes, label) {
    return {
      or(other) {
        return locator(
          () => [...new Set([...nodes(), ...other.nodes()])],
          `${label}|${other.label}`,
        );
      },
      filter(options) {
        assert.deepEqual(options, { visible: true }, "The ready union filters actual visible DOM");
        return locator(() => nodes().filter(visible), label);
      },
      first() {
        return locator(() => nodes().slice(0, 1), label);
      },
      nodes,
      label,
      async isVisible() {
        assert.ok(nodes().length <= 1, "A singular locator cannot silently choose another control");
        const result = nodes().some(visible);
        trace.push({ kind: "is-visible", label, result });
        return result;
      },
      async waitFor(options = {}) {
        assert.equal(options.state ?? "visible", "visible");
        trace.push({ kind: "wait-visible", label });
        firstWait.resolve();
        if (nodes().some(visible)) {
          trace.push({ kind: "observed-visible", label });
          return;
        }
        if (navigationSettled) throw unavailable();
        // 原因：Root 画出导航前不能假报就绪；由实际 DOM 提交或明确终结 gate 解除，禁止 sleep。
        await new Promise((resolve, reject) => pending.add({ nodes, label, resolve, reject }));
      },
      async click() {
        const elements = nodes();
        assert.equal(elements.length, 1);
        assert.ok(visible(elements[0]), "Only a real visible button receives ordinary click");
        assert.equal(elements[0].tagName, "BUTTON");
        elements[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      },
    };
  }
  const page = {
    getByRole(role, { name }) {
      assert.equal(role, "button");
      assert.ok(name instanceof RegExp);
      return locator(
        () =>
          [...document.querySelectorAll("button")].filter((node) =>
            name.test(node.getAttribute("aria-label") ?? node.textContent),
          ),
        "back",
      );
    },
    getByTestId(id) {
      assert.equal(id, "sidebar");
      return locator(() => [...document.querySelectorAll('[data-testid="sidebar"]')], "sidebar");
    },
  };

  function mountHome(hidden = false) {
    document.body.replaceChildren();
    const sidebar = document.createElement("nav");
    sidebar.dataset.testid = "sidebar";
    sidebar.hidden = hidden;
    document.body.append(sidebar);
  }
  function mountChat() {
    document.body.replaceChildren();
    const back = document.createElement("button");
    back.setAttribute("aria-label", "返回任务首页");
    back.addEventListener("click", () => {
      clickCount++;
      trace.push({ kind: "click-back" });
      mountHome();
    });
    document.body.append(back);
  }
  return {
    trace,
    firstWait: firstWait.promise,
    mountHome,
    mountChat,
    hasVisibleHome: () => visible(document.querySelector('[data-testid="sidebar"]')),
    clicks: () => clickCount,
    completed: () => completed,
    start() {
      assert.equal(outcome, undefined, "One helper invocation per fixture");
      outcome = helpers.showMobileTaskHome(page).then(
        () => {
          completed = true;
          return { completed: true };
        },
        (error) => ({ completed: false, errorCode: error.code ?? error.name }),
      );
      return outcome;
    },
    finishNavigation() {
      navigationSettled = true;
      observeDom();
    },
    async dispose() {
      navigationSettled = true;
      observeDom();
      if (outcome) await outcome;
      observer.disconnect();
      dom.window.close();
    },
  };
}

test("startup without navigation waits for the later Back and really clicks into Home", async (t) => {
  t.diagnostic("actual web-remote-unread.ts SHA256: " + sourceSha256);
  const f = fixture();
  t.after(() => f.dispose());
  const outcome = f.start();
  await f.firstWait;
  assert.equal(f.completed(), false);
  assert.equal(f.clicks(), 0);
  f.mountChat();
  assert.equal(f.hasVisibleHome(), false);
  f.finishNavigation();
  assert.deepEqual(
    await outcome,
    { completed: true },
    "The actual helper must observe and click the later Back",
  );
  assert.equal(f.clicks(), 1);
  assert.equal(f.hasVisibleHome(), true);
  assert.equal(f.trace.at(-1)?.kind, "observed-visible");
});

test("startup keeps hidden navigation unready until the real Home appears", async (t) => {
  const f = fixture();
  t.after(() => f.dispose());
  f.mountHome(true);
  const outcome = f.start();
  await f.firstWait;
  assert.equal(f.completed(), false, "A hidden sidebar cannot satisfy navigation readiness");
  assert.equal(f.hasVisibleHome(), false);
  f.mountHome();
  f.finishNavigation();
  assert.deepEqual(await outcome, { completed: true });
  assert.equal(f.clicks(), 0);
  assert.equal(f.hasVisibleHome(), true);
});

test("an existing Chat receives exactly one ordinary Back click and ends in visible Home", async (t) => {
  const f = fixture();
  t.after(() => f.dispose());
  f.mountChat();
  assert.deepEqual(await f.start(), { completed: true });
  assert.equal(f.clicks(), 1);
  assert.equal(f.hasVisibleHome(), true);
});

test("an existing Home adds no Back click and still observes the real sidebar", async (t) => {
  const f = fixture();
  t.after(() => f.dispose());
  f.mountHome();
  assert.deepEqual(await f.start(), { completed: true });
  assert.equal(f.clicks(), 0);
  assert.equal(f.hasVisibleHome(), true);
  assert.equal(f.trace.at(-1)?.kind, "observed-visible");
});

test("permanently absent navigation fails explicitly without invented Home or input", async (t) => {
  const f = fixture();
  t.after(() => f.dispose());
  const outcome = f.start();
  await f.firstWait;
  assert.equal(f.completed(), false);
  f.finishNavigation();
  assert.deepEqual(await outcome, { completed: false, errorCode: "NCTX_NAV_NOT_READY" });
  assert.equal(f.completed(), false);
  assert.equal(f.clicks(), 0);
  assert.equal(f.hasVisibleHome(), false);
});
