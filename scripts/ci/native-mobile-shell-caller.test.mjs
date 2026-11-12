import assert from "node:assert/strict";
import test from "node:test";
import {
  createShellFixture,
  identity,
  loadActualAppCaller,
  taskId,
  workspace,
} from "./fixtures/native-mobile-shell-caller.mjs";

// 第六轮真实 PNG/DOM 已证明 media 命中却走桌面工作台；不能从 test 预期字段合成调用 props。
for (const [field, value] of [
  ["webRemoteControlWorkspaceSwitcher", Object.freeze({ updateMobileTaskView() {} })],
  ["initialSidebarFileTreeOpen", true],
  ["initialWebRemoteControlMobileNavigationIntent", "chat"],
  ["webRemoteControlTerminalTransportState", "paired"],
]) {
  test("actual App caller preserves existing " + field, async () => {
    const caller = await loadActualAppCaller();
    const result = caller({ [field]: value });
    assert.equal(result.props[field], value);
  });
}

test("ordinary desktop App caller does not create a remote switcher or initial navigation", async () => {
  const caller = await loadActualAppCaller();
  const result = caller({ isDesktop: true });
  for (const field of [
    "webRemoteControlWorkspaceSwitcher",
    "initialSidebarFileTreeOpen",
    "initialWebRemoteControlMobileNavigationIntent",
    "webRemoteControlTerminalTransportState",
  ])
    assert.equal(result.props[field], undefined);
  assert.equal(result.props.isDesktop, true);
});

for (const width of [320, 390, 736]) {
  test("actual App and Shell mount mobile Home at " + width + "px", async () => {
    const fixture = await createShellFixture(width);
    try {
      await fixture.render();
      assert.ok(fixture.document.querySelector('[data-mobile-page="home"]'));
      assert.equal(fixture.document.querySelector('[data-testid="fixture-wide"]'), null);
      assert.equal(fixture.views.at(-1), null, "Home must not claim an actual task view");
      assert.deepEqual(fixture.navigation.at(-1), [identity, taskId]);
    } finally {
      await fixture.close();
    }
  });
}

test("actual Home control enters chat and the original Reporter emits the visible committed task", async () => {
  const fixture = await createShellFixture();
  try {
    await fixture.render();
    await fixture.click('[data-testid="fixture-open-task"]');
    assert.ok(fixture.document.querySelector('[data-mobile-page="chat"]'));
    assert.ok(fixture.document.querySelector('[data-testid="fixture-chat"]'));
    assert.deepEqual(fixture.views.at(-1), {
      workspacePath: workspace,
      workspaceIdentity: identity,
      taskId,
    });
    await fixture.hide();
    assert.equal(fixture.views.at(-1), null, "background visibility must revoke the actual view");
  } finally {
    await fixture.close();
  }
});

test("initial chat intent reaches the actual Shell without a second navigation owner", async () => {
  const fixture = await createShellFixture();
  try {
    await fixture.render({ initialWebRemoteControlMobileNavigationIntent: "chat" });
    assert.ok(fixture.document.querySelector('[data-mobile-page="chat"]'));
    assert.equal(fixture.document.querySelector('[data-mobile-page="home"]'), null);
    assert.deepEqual(fixture.views.at(-1), {
      workspacePath: workspace,
      workspaceIdentity: identity,
      taskId,
    });
  } finally {
    await fixture.close();
  }
});

test("wide remote Shell preserves desktop content and keeps the same actual view Reporter", async () => {
  const fixture = await createShellFixture(1024);
  try {
    await fixture.render();
    assert.ok(fixture.document.querySelector('[data-testid="fixture-wide"]'));
    assert.equal(fixture.document.querySelector("[data-mobile-page]"), null);
    assert.deepEqual(fixture.views.at(-1), {
      workspacePath: workspace,
      workspaceIdentity: identity,
      taskId,
    });
    await fixture.update({ isWorkspaceVisible: false });
    assert.equal(fixture.views.at(-1), null, "hidden workspace must not keep a reported view");
  } finally {
    await fixture.close();
  }
});

test("uncommitted task navigation cannot acquire a view from a visible chat pane", async () => {
  const fixture = await createShellFixture();
  try {
    fixture.state.taskNavHistory.entries[0].taskId = "another-fixture-task";
    await fixture.render({ initialWebRemoteControlMobileNavigationIntent: "chat" });
    assert.ok(fixture.document.querySelector('[data-mobile-page="chat"]'));
    assert.equal(fixture.views.at(-1), null);
  } finally {
    await fixture.close();
  }
});

test("existing terminal state reaches the actual mobile reconnect notice", async () => {
  const fixture = await createShellFixture();
  try {
    await fixture.render({ webRemoteControlTerminalTransportState: "reconnecting" });
    assert.ok(fixture.document.querySelector('[data-web-remote-control-reconnect-notice="true"]'));
    assert.equal(fixture.views.at(-1), null);
  } finally {
    await fixture.close();
  }
});
