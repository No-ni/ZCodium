import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";
import {
  directory,
  task,
  workspace,
  rawError,
  withinBoundary,
  fixture,
  creator,
} from "./fixtures/native-mobile-evidence.mjs";

test("actual collector persists stage and DOM before Main, and records only bounded structure", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.run();
  assert.deepEqual(f.events, [
    "write-begin",
    "dom-read",
    "write-surface",
    "main-read",
    "write-main",
    "png-attempt",
    "write-screenshot",
  ]);
  const rows = await f.rows();
  assert.deepEqual(
    rows.map((row) => row.part),
    ["begin", "surface", "main", "screenshot"],
  );
  assert.equal(rows[1].surface.page, "chat");
  assert.equal(rows[1].surface.paneSessionMatches, true);
  assert.deepEqual(rows[1].surface.viewport, { width: 390, height: 844 });
  assert.equal(rows[1].surface.mobileViewport, true);
  assert.equal(rows[1].surface.rootStartupBusy, true);
  assert.equal(rows[1].surface.databaseStartupBusy, false);
  assert.equal(rows[1].surface.workspaceSurface, "interactive");
  assert.equal(rows[2].main.taskMatches, true);
  assert.equal(rows[2].main.workspaceMatches, true);
  assert.equal(rows[3].code, "ok");
  const encoded = JSON.stringify(rows);
  for (const forbidden of [
    task,
    workspace,
    rawError.message,
    "data-sensitive",
    "http://",
    "session-id",
  ])
    assert.equal(encoded.includes(forbidden), false, forbidden);
});

for (const kind of ["dom", "main"]) {
  for (const failure of ["reject", "pending"]) {
    test(`actual ${kind} ${failure} retains all independently available evidence and attempts PNG`, async (t) => {
      const f = await fixture({ [kind + "Failure"]: failure });
      t.after(f.close);
      await f.run();
      const rows = await f.rows();
      assert.deepEqual(
        rows.map((row) => row.part),
        ["begin", "surface", "main", "screenshot"],
      );
      assert.equal(
        rows.find((row) => row.part === (kind === "dom" ? "surface" : "main")).code,
        failure === "pending" ? "read-timeout" : "read-failed",
      );
      assert.equal(
        rows.find((row) => row.part === (kind === "dom" ? "main" : "surface")).code,
        "ok",
      );
      assert.equal(rows.at(-1).code, "ok");
      assert.ok(f.events.includes("png-attempt"));
    });
  }
}

test("actual invalid Main data is a finite diagnostic code rather than a readable owner fact", async (t) => {
  const f = await fixture({ mainFailure: "invalid" });
  t.after(f.close);
  await f.run();
  const main = (await f.rows()).find((row) => row.part === "main");
  assert.equal(main.code, "invalid-result");
  assert.equal(main.main, null);
});

test("actual late Main completion cannot append or replace the already persisted timeout", async (t) => {
  const f = await fixture({ mainFailure: "held" });
  t.after(f.close);
  await f.run();
  const before = await f.rows();
  assert.equal(before.find((row) => row.part === "main").code, "read-timeout");
  assert.equal(f.outstandingTimers(), 0);
  f.releaseMain();
  await Promise.resolve();
  assert.deepEqual(await f.rows(), before);
});

for (const failure of ["reject", "pending"]) {
  test(`actual PNG ${failure} records its own code without discarding DOM or Main`, async (t) => {
    const f = await fixture({ pngFailure: failure });
    t.after(f.close);
    await f.run();
    const rows = await f.rows();
    assert.equal(rows[1].code, "ok");
    assert.equal(rows[2].code, "ok");
    assert.equal(rows[3].code, failure === "pending" ? "read-timeout" : "read-failed");
  });
}

test("actual unknown stages cannot enter JSONL or screenshot filenames", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.run("../../SYNTHETIC_PRIVATE_STAGE_DO_NOT_RECORD");
  const rows = await f.rows();
  assert.ok(rows.every((row) => row.stage === "unknown"));
  assert.equal(rows.at(-1).code, "not-requested");
  assert.equal(f.events.includes("png-attempt"), false);
});

test("actual painted visibility notices hidden ancestors without copying text or DOM", async (t) => {
  const f = await fixture({ hidden: true });
  t.after(f.close);
  await f.run();
  const surface = (await f.rows())[1].surface;
  assert.equal(surface.panePresent, true);
  assert.equal(surface.paneVisible, false);
  assert.equal(surface.nativeContextEntryVisible, false);
});

test("actual admission preserves its original failure and only closes context after independent evidence attempts", async (t) => {
  const f = await fixture({ mainFailure: "pending", pngFailure: "reject" });
  t.after(f.close);
  const run = await creator(f);
  await assert.rejects(
    withinBoundary(() => run(f.diagnostics)),
    (error) => error === rawError,
  );
  assert.equal(f.events.at(-1), "context-close");
  assert.ok(f.events.indexOf("png-attempt") < f.events.indexOf("context-close"));
  const rows = await f.rows(join(f.diagnostics, "mobile"));
  assert.equal(rows.find((row) => row.part === "surface").code, "ok");
  assert.equal(rows.find((row) => row.part === "main").code, "read-timeout");
  assert.equal(rows.at(-1).code, "read-failed");
});

test("actual admission and context cleanup errors remain ordered after PNG", async (t) => {
  const f = await fixture({ domFailure: "reject" });
  t.after(f.close);
  const cleanupError = new Error("synthetic cleanup failure");
  const run = await creator(f, { cleanupError });
  await assert.rejects(
    withinBoundary(() => run(f.diagnostics)),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [rawError, cleanupError]);
      return true;
    },
  );
  assert.ok(f.events.includes("png-attempt"));
  assert.ok(f.events.indexOf("png-attempt") < f.events.indexOf("context-close"));
});

test("actual storage failure still attempts Main and PNG and preserves admission as the first error", async (t) => {
  const f = await fixture({ appendFailureAt: 1 });
  t.after(f.close);
  const run = await creator(f);
  await assert.rejects(
    withinBoundary(() => run(f.diagnostics)),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], rawError);
      assert.equal(error.errors[1].message, "NCTX_MOBILE_EVIDENCE_WRITE_FAILED");
      return true;
    },
  );
  assert.ok(f.events.includes("main-read"));
  assert.ok(f.events.includes("png-attempt"));
  assert.equal(f.events.at(-1), "context-close");
});

test("actual write and cleanup failures stay after admission while the independent PNG failure code survives", async (t) => {
  const f = await fixture({ appendFailureAt: 0, pngFailure: "reject" });
  t.after(f.close);
  const cleanupError = new Error("synthetic cleanup failure");
  const run = await creator(f, { cleanupError });
  await assert.rejects(
    withinBoundary(() => run(f.diagnostics)),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], rawError);
      assert.equal(error.errors[1].message, "NCTX_MOBILE_EVIDENCE_WRITE_FAILED");
      assert.equal(error.errors[2], cleanupError);
      return true;
    },
  );
  const rows = await f.rows(join(f.diagnostics, "mobile"));
  assert.equal(rows.at(-1).part, "screenshot");
  assert.equal(rows.at(-1).code, "read-failed");
  assert.equal(f.events.at(-1), "context-close");
});

test("actual successful admission returns the same live context without cleanup", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const run = await creator(f, { admissionError: null });
  const result = await run(f.diagnostics);
  assert.equal(result.page, f.page);
  assert.equal(f.events.includes("context-close"), false);
  await result.close();
  assert.equal(f.events.at(-1), "context-close");
});

for (const failed of [true, false])
  test(`actual onboarding records reload stages when visible-page admission ${failed ? "fails" : "succeeds"}`, async () => {
    const stages = [];
    const cancel = { isVisible: async () => false, waitFor: async () => {} };
    const page = {
      getByTestId: () => cancel,
      reload: async () => {
        stages.push("reload");
      },
      bringToFront: async () => {},
      waitForFunction: async () => {},
      locator: () => ({
        waitFor: async () => {
          if (failed) throw rawError;
        },
      }),
    };
    const run = await loadComponentCallback(
      directory + "mobile-onboarding.ts",
      "prepareNativeContextMobileOnboarding",
      {
        readNativeContextFirstRunHandled: async () => true,
        browser: {
          waitUntil: async (predicate) => {
            assert.equal(await predicate(), true);
          },
        },
        expect: (value) => ({ toBe: (expected) => assert.equal(value, expected) }),
      },
    );
    const action = () =>
      run(page, async (stage) => {
        stages.push(stage);
      });
    if (failed) await assert.rejects(action(), (error) => error === rawError);
    else assert.equal((await action()).handledAfterReload, true);
    assert.deepEqual(stages, [
      "onboarding-before-reload",
      "reload",
      "onboarding-after-reload",
      ...(failed ? [] : ["onboarding-ready"]),
    ]);
  });
