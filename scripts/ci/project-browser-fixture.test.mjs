import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { projectRoot, projectValidationRoot } from "./project-test-sandbox.mjs";

test("browser fixtures reject outside entries without changing the environment", async () => {
  const before = { ...process.env };
  await assert.rejects(
    startProjectBrowserFixture({ label: "browser-outside", entry: "../outside.html" }),
    /PROJECT_TEST_PATH_REJECTED/,
  );
  assert.deepEqual({ ...process.env }, before);
});

test("browser fixture owns one environment lease and its actual loopback address", async () => {
  const before = { ...process.env };
  const fixture = await startProjectBrowserFixture({
    label: "browser-owner-test",
    entry: "packages/ui/test/adoption-collapsible.html",
    tailwind: false,
  });
  try {
    assert.equal(
      dirname(fixture.sandbox.root),
      before.PROJECT_TEST_SANDBOX_ROOT
        ? join(before.PROJECT_TEST_SANDBOX_ROOT, "children")
        : projectValidationRoot,
    );
    assert.equal(process.env.PROJECT_TEST_SANDBOX_ROOT, fixture.sandbox.root);
    await assert.rejects(
      startProjectBrowserFixture({
        label: "browser-second-owner",
        entry: "packages/ui/test/adoption-collapsible.html",
        tailwind: false,
      }),
      /PROJECT_BROWSER_FIXTURE_ACTIVE/,
    );
    const address = fixture.server.httpServer.address();
    assert.equal(address.address, "127.0.0.1");
    assert.equal(new URL(fixture.origin).port, String(address.port));
    const response = await fetch(fixture.url);
    assert.equal(response.status, 200);
    const record = JSON.parse(await readFile(join(fixture.sandbox.root, "fixture.json"), "utf8"));
    assert.equal(record.url, fixture.url);
  } finally {
    await fixture.close();
    await fixture.close();
  }
  assert.deepEqual({ ...process.env }, before);
});

test("closed fixtures release the lease without nesting a later sandbox", async () => {
  const before = { ...process.env };
  const fixture = await startProjectBrowserFixture({
    label: "browser-next-owner-test",
    entry: "packages/ui/test/adoption-collapsible.html",
    tailwind: false,
  });
  try {
    assert.equal(
      dirname(fixture.sandbox.root),
      before.PROJECT_TEST_SANDBOX_ROOT
        ? join(before.PROJECT_TEST_SANDBOX_ROOT, "children")
        : projectValidationRoot,
    );
    assert.equal(resolve(fixture.server.config.root), projectRoot);
  } finally {
    await fixture.close();
  }
});
