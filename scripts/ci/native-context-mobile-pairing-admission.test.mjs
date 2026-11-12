import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";
import { assertProjectPath, createProjectTestFixture } from "./project-test-sandbox.mjs";

const source =
  "packages/desktop/test/e2e/helpers/native-context-compression/mobile-pairing-admission.ts";
const logoSelector = '[data-testid="desktop-top-logo-sidebar-toggle"]';

async function fixture({
  hidden = true,
  blockedEntry = false,
  blockedToggle = false,
  disabledEntry = false,
  outsidePanel = false,
  offscreen = false,
  expandingAnimations = 0,
  infiniteAnimation = false,
  pairingError,
  restoreError,
} = {}) {
  const diagnostics = await createProjectTestFixture("native-pairing-admission");
  const dom = new JSDOM(`<main>
    <button data-testid="desktop-top-logo-sidebar-toggle"><span></span></button>
    <div data-workspace-sidebar-panel="true"><aside aria-hidden="${hidden}">
      <button aria-label="移动端远程控制"><svg><path></path></svg></button>
    </aside></div><div id="blocker"></div></main>`);
  const document = dom.window.document;
  const panel = document.querySelector('[data-workspace-sidebar-panel="true"]');
  const aside = panel.querySelector("aside");
  const entry = panel.querySelector("button");
  const toggle = document.querySelector(logoSelector);
  const blocker = document.getElementById("blocker");
  if (outsidePanel) document.querySelector("main").append(entry);
  if (disabledEntry) entry.disabled = true;
  panel.style.opacity = hidden ? "0" : "1";
  let animations = 0;
  let toggles = 0;
  let pairings = 0;
  let polls = 0;
  const events = [];
  const box = (x, y, width, height) => ({ x, y, width, height });
  dom.window.Element.prototype.getBoundingClientRect = function () {
    if (this === entry) return box(offscreen ? 1400 : 44, 754, 32, 32);
    if (this === toggle) return box(12, 12, 32, 32);
    return box(0, 0, 264, 802);
  };
  dom.window.Element.prototype.getAnimations = function () {
    if (this !== panel) return [];
    if (!animations && !infiniteAnimation) return [];
    return [
      {
        playState: "running",
        pending: false,
        effect: { getComputedTiming: () => ({ iterations: animations ? 1 : Infinity }) },
      },
    ];
  };
  document.elementFromPoint = (_x, y) => {
    const dialog = document.querySelector('[data-testid="web-remote-control-dialog-scroll"]');
    if (dialog) return dialog;
    if (y < 100) return blockedToggle ? blocker : toggle.firstElementChild;
    return hidden || blockedEntry ? blocker : entry.firstElementChild;
  };
  const read = await loadComponentCallback(source, "readNativeContextDesktopPairingSurface", {
    document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    innerWidth: 1200,
    innerHeight: 802,
  });
  const browser = {
    execute: async (callback) => {
      assert.equal(callback, read, "renderer calls must only read the actual admission surface");
      return read();
    },
    waitUntil: async (predicate, options) => {
      for (let index = 0; index < 6; index++) {
        polls++;
        if (await predicate()) return;
        if (animations) animations--;
      }
      throw new Error(options.timeoutMsg);
    },
    keys: async (key) => {
      assert.equal(key, "Escape");
      events.push("close-pairing-dialog");
      document.querySelector('[data-testid="web-remote-control-dialog-scroll"]')?.remove();
    },
  };
  const record = await loadComponentCallback(source, "recordNativeContextDesktopPairingSurface", {
    browser,
    readNativeContextDesktopPairingSurface: read,
    assertNativeContextTestPath: assertProjectPath,
    appendFile,
    join,
  });
  const cleanup = await loadComponentCallback(
    "packages/desktop/test/e2e/helpers/native-context-compression/cleanup.ts",
    "withNativeContextCleanup",
    {},
  );
  const run = await loadComponentCallback(source, "obtainNativeContextPairingUrl", {
    assert,
    browser,
    readNativeContextDesktopPairingSurface: read,
    recordNativeContextDesktopPairingSurface: record,
    withNativeContextCleanup: cleanup,
    $: (selector) => {
      assert.equal(selector, logoSelector, "sidebar writes must use the public logo click");
      return {
        click: async () => {
          if (toggles === 1 && restoreError) throw restoreError;
          assert.equal(read().toggle.centerHit, true);
          toggles++;
          hidden = !hidden;
          aside.setAttribute("aria-hidden", String(hidden));
          panel.style.opacity = hidden ? "0" : "1";
          animations = hidden ? 0 : expandingAnimations;
          events.push(hidden ? "collapse-sidebar" : "expand-sidebar");
        },
      };
    },
    obtainUnreadPairingUrl: async (origin) => {
      const surface = read();
      assert.equal(origin, "http://127.0.0.1:1234");
      assert.equal(surface.panel.ariaHidden, false);
      assert.equal(surface.entry.painted, true);
      assert.equal(surface.entry.centerHit, true);
      assert.equal(surface.animationPending, false);
      pairings++;
      events.push("pairing");
      if (pairingError) {
        const dialog = document.createElement("div");
        dialog.dataset.testid = "web-remote-control-dialog-scroll";
        dialog.setAttribute("role", "dialog");
        document.querySelector("main").append(dialog);
        throw pairingError;
      }
      return "http://127.0.0.1:1234/mobile.html";
    },
  });
  return {
    run: () => run("http://127.0.0.1:1234", diagnostics),
    events,
    read,
    pairings: () => pairings,
    toggles: () => toggles,
    polls: () => polls,
    evidence: async () =>
      (
        await readFile(
          await assertProjectPath(join(diagnostics, "desktop-pairing-admission.jsonl")),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    close: () => dom.window.close(),
  };
}

test("actual pairing admission opens the public sidebar, waits finite animation and restores its original state", async (t) => {
  const f = await fixture({ expandingAnimations: 2 });
  t.after(f.close);
  assert.equal(await f.run(), "http://127.0.0.1:1234/mobile.html");
  assert.deepEqual(f.events, ["expand-sidebar", "pairing", "collapse-sidebar"]);
  assert.ok(f.polls() > 3);
  assert.equal(f.toggles(), 2);
  assert.equal(f.read().panel.ariaHidden, true);
  const evidence = await f.evidence();
  assert.deepEqual(
    evidence.map((item) => item.stage),
    ["before", "ready", "restored"],
  );
  assert.equal(evidence[0].surface.entry.painted, false);
  assert.equal(evidence[1].surface.entry.centerHit, true);
  assert.equal(evidence[1].surface.animationPending, false);
});

test("actual pairing admission preserves an already visible sidebar and ignores infinite animations", async (t) => {
  const f = await fixture({ hidden: false, infiniteAnimation: true });
  t.after(f.close);
  await f.run();
  assert.equal(f.toggles(), 0);
  assert.equal(f.read().panel.ariaHidden, false);
  assert.deepEqual(f.events, ["pairing"]);
});

for (const [name, options] of [
  ["occluded", { blockedEntry: true }],
  ["disabled", { disabledEntry: true }],
  ["offscreen", { offscreen: true }],
  ["outside the real sidebar", { outsidePanel: true }],
]) {
  test(`actual pairing admission rejects an entry ${name}, retains failure structure and restores sidebar`, async (t) => {
    const f = await fixture(options);
    t.after(f.close);
    await assert.rejects(f.run(), /not painted and hit-testable/u);
    assert.equal(f.pairings(), 0);
    assert.equal(f.read().panel.ariaHidden, true);
    const evidence = await f.evidence();
    assert.deepEqual(
      evidence.map((item) => item.stage),
      ["before", "pairing-failed", "restored"],
    );
    const failed = evidence[1].surface;
    if (options.blockedEntry) {
      assert.equal(failed.entry.painted, true);
      assert.equal(failed.entry.centerHit, false);
      assert.equal(failed.entry.hitTag, "DIV");
    }
    if (options.disabledEntry) assert.equal(failed.entry.disabled, true);
    if (options.offscreen) assert.equal(failed.entry.hitTag, null);
    if (options.outsidePanel) assert.equal(failed.entry.inPanel, false);
  });
}

test("actual pairing admission does not click an occluded public logo or start pairing", async (t) => {
  const f = await fixture({ blockedToggle: true });
  t.after(f.close);
  await assert.rejects(f.run(), /sidebar toggle is not ready/u);
  assert.equal(f.pairings(), 0);
  assert.equal(f.toggles(), 0);
  const evidence = await f.evidence();
  assert.equal(evidence.at(-1).stage, "pairing-failed");
  assert.equal(evidence.at(-1).surface.toggle.centerHit, false);
});

test("actual pairing failure is preserved, closes its own dialog and captures no URL or raw error", async (t) => {
  const error = new Error("SYNTHETIC_PAIRING_ERROR_DO_NOT_RECORD");
  const f = await fixture({ pairingError: error });
  t.after(f.close);
  await assert.rejects(f.run(), (caught) => caught === error);
  assert.deepEqual(f.events, [
    "expand-sidebar",
    "pairing",
    "close-pairing-dialog",
    "collapse-sidebar",
  ]);
  const evidence = await f.evidence();
  assert.equal(
    evidence.find((item) => item.stage === "pairing-failed").surface.pairingDialogPresent,
    true,
  );
  const encoded = JSON.stringify(evidence);
  assert.equal(encoded.includes("http://"), false);
  assert.equal(encoded.includes(error.message), false);
});

test("actual pairing and restoration errors remain together with both failure snapshots", async (t) => {
  const pairingError = new Error("SYNTHETIC_PAIRING_ERROR");
  const restoreError = new Error("SYNTHETIC_RESTORE_ERROR");
  const f = await fixture({ pairingError, restoreError });
  t.after(f.close);
  await assert.rejects(f.run(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [pairingError, restoreError]);
    return true;
  });
  const stages = (await f.evidence()).map((item) => item.stage);
  assert.ok(stages.includes("pairing-failed"));
  assert.ok(stages.includes("restore-failed"));
});
