import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { loadMobileIntlSource } from "./fixtures/native-mobile-intl-source.mjs";

const source = await loadMobileIntlSource();
let dom;
let root;
let globals;
let unhandled;
let onUnhandled;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await act(async () => {
    await immediate();
  });
}

beforeEach(() => {
  dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
  globals = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(dom.window.navigator, "language", { value: "en-US", configurable: true });
  root = createRoot(dom.window.document.getElementById("root"));
  unhandled = [];
  onUnhandled = () => {
    unhandled.push("async-owner-rejection");
  };
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  await immediate();
  process.removeListener("unhandledRejection", onUnhandled);
  dom.window.close();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

function fixture() {
  const state = {
    settings: { locale: "zh-CN", localePreference: "system" },
    updates: [],
    broadcasts: [],
    localWrites: [],
    resolverCalls: 0,
    resolve: async () => "zh-CN",
    getFailure: false,
    broadcastFailure: false,
    listener: () => {},
    slotCurrent: true,
  };
  const originalSetItem = dom.window.Storage.prototype.setItem;
  dom.window.Storage.prototype.setItem = function (key, value) {
    if (key === "zcode-locale-preference") state.localWrites.push(value);
    return originalSetItem.call(this, key, value);
  };
  state.settingsService = {
    get: async () => {
      if (state.getFailure) throw new Error("controlled-initial-get-failure");
      return state.settings;
    },
    update: async (patch) => {
      state.updates.push(patch);
      Object.assign(state.settings, patch);
    },
  };
  state.broadcastService = {
    send: async (payload) => {
      state.broadcasts.push(payload);
      if (state.broadcastFailure) throw new Error("controlled-broadcast-failure");
      await state.broadcastGate?.(payload);
    },
    onMessage: (listener) => {
      state.listener = listener;
      return { dispose() {} };
    },
  };
  state.resolveSystemLocale = async () => {
    state.resolverCalls++;
    return state.resolve();
  };
  state.access = {
    descriptor: {
      workspacePath: "/source-fixture",
      workspaceKey: "/source-fixture",
      kind: "local",
    },
    generation: 1,
    isCurrent: () => true,
    services: { settingService: state.settingsService, broadcastService: state.broadcastService },
  };
  state.slot = source.createMobileRootSlot(
    state.access,
    { workspaceKey: "/source-fixture", revision: 0 },
    "source-window",
    { getSystemLocale: state.resolveSystemLocale },
    {},
    () => state.slotCurrent,
  );
  return state;
}

async function renderSurface(state) {
  await act(async () => {
    root.render(
      React.createElement(source.RootSurface, {
        snapshot: { slot: state.slot, loading: false, error: false },
        title: "source fixture",
        description: "source fixture",
        onRetry() {},
      }),
    );
  });
  await settle();
}

function Probe() {
  const value = source.useZCodeIntl();
  return React.createElement(
    "div",
    null,
    React.createElement("output", {
      "data-locale": value.locale,
      "data-preference": value.localePreference,
    }),
    ...["system", "zh-CN", "en-US"].map((preference) =>
      React.createElement(
        "button",
        {
          key: preference,
          "data-action": preference,
          onClick: () => value.setLocalePreference(preference),
        },
        preference,
      ),
    ),
  );
}

async function renderProvider(state, resolver, preferSettingServiceLocale = true) {
  await act(async () => {
    root.render(
      React.createElement(
        source.ZCodeIntlProvider,
        {
          settingService: state.settingsService,
          broadcastService: state.broadcastService,
          preferSettingServiceLocale,
          resolveSystemLocale: resolver,
        },
        React.createElement(Probe),
      ),
    );
  });
  await settle();
}

async function choose(preference) {
  const button = dom.window.document.querySelector(`[data-action='${preference}']`);
  assert.ok(button);
  await act(async () => {
    button.click();
  });
  await settle();
}

function view() {
  const element = dom.window.document.querySelector("output");
  assert.ok(element);
  return { locale: element.dataset.locale, preference: element.dataset.preference };
}

for (const stored of ["en-US", "system"]) {
  test(`actual mobile Intl keeps Host system and zh-CN over phone and stored ${stored}`, async () => {
    const state = fixture();
    dom.window.localStorage.setItem("zcode-locale-preference", stored);
    await renderSurface(state);
    assert.deepEqual(view(), { locale: "zh-CN", preference: "system" });
    assert.equal(state.resolverCalls, 1);
    assert.deepEqual(state.updates, []);
    assert.deepEqual(state.broadcasts, []);
    assert.deepEqual(unhandled, []);
  });
}

test("actual Intl seeds Host resolved locale while the OS resolver is pending", async () => {
  const state = fixture();
  const pending = deferred();
  state.resolve = () => pending.promise;
  await renderSurface(state);
  assert.deepEqual(view(), { locale: "zh-CN", preference: "system" });
  assert.deepEqual(state.updates, []);
  pending.resolve("en-US");
  await settle();
  assert.deepEqual(view(), { locale: "en-US", preference: "system" });
  assert.deepEqual(state.updates, [{ locale: "en-US", localePreference: "system" }]);
});

test("actual mobile Intl rereads changed Host OS locale on remount and preserves system", async () => {
  const state = fixture();
  await renderSurface(state);
  await act(async () => {
    root.unmount();
  });
  root = createRoot(dom.window.document.getElementById("root"));
  state.resolve = async () => "en-US";
  await renderSurface(state);
  assert.deepEqual(view(), { locale: "en-US", preference: "system" });
  assert.deepEqual(state.updates, [{ locale: "en-US", localePreference: "system" }]);
  assert.deepEqual(unhandled, []);
});

test("actual legacy prefer-service Intl without Host resolver keeps resolved locale compatibility", async () => {
  const state = fixture();
  await renderProvider(state, undefined);
  assert.deepEqual(view(), { locale: "zh-CN", preference: "zh-CN" });
  assert.deepEqual(state.updates, []);
});

test("actual current system selection calls Host and a later explicit language wins", async () => {
  const state = fixture();
  await renderSurface(state);
  await choose("system");
  assert.deepEqual(view(), { locale: "zh-CN", preference: "system" });
  assert.deepEqual(state.updates, [{ locale: "zh-CN", localePreference: "system" }]);
  const pending = deferred();
  state.resolve = () => pending.promise;
  await choose("system");
  await choose("en-US");
  const before = state.updates.length;
  pending.resolve("zh-CN");
  await settle();
  assert.equal(state.updates.length, before);
  assert.deepEqual(view(), { locale: "en-US", preference: "en-US" });
  assert.deepEqual(unhandled, []);
});

test("actual Provider unmount fences a late successful system result without relying on bridge disposal", async () => {
  const state = fixture();
  await renderSurface(state);
  const pending = deferred();
  state.resolve = () => pending.promise;
  await choose("system");
  await act(async () => {
    root.unmount();
  });
  pending.resolve("zh-CN");
  await settle();
  assert.deepEqual(state.updates, []);
  assert.deepEqual(state.broadcasts, []);
  assert.deepEqual(unhandled, []);
});

for (const dependency of ["settings", "broadcast", "resolver"]) {
  test(`actual same Provider ${dependency} replacement cancels an old system result`, async () => {
    const state = fixture();
    state.settings = { locale: "en-US", localePreference: "en-US" };
    await renderProvider(state, state.resolveSystemLocale);
    const pending = deferred();
    state.resolve = () => pending.promise;
    await choose("system");
    const nextUpdates = [];
    const nextBroadcasts = [];
    if (dependency === "settings") {
      state.settingsService = {
        get: async () => ({ locale: "en-US", localePreference: "en-US" }),
        update: async (patch) => {
          nextUpdates.push(patch);
        },
      };
    }
    if (dependency === "broadcast") {
      state.broadcastService = {
        send: async (payload) => {
          nextBroadcasts.push(payload);
        },
        onMessage: (listener) => {
          state.listener = listener;
          return { dispose() {} };
        },
      };
    }
    const resolver = dependency === "resolver" ? async () => "en-US" : state.resolveSystemLocale;
    await renderProvider(state, resolver);
    pending.resolve("zh-CN");
    await settle();
    assert.deepEqual(state.updates, []);
    assert.deepEqual(nextUpdates, []);
    assert.deepEqual(state.broadcasts, []);
    assert.deepEqual(nextBroadcasts, []);
    assert.deepEqual(unhandled, []);
    await choose("en-US");
    assert.deepEqual(
      [...state.updates, ...nextUpdates],
      [{ locale: "en-US", localePreference: "en-US" }],
    );
  });
}

test("actual current resolver rejection has no unhandled error and explicit language remains usable", async () => {
  const state = fixture();
  await renderSurface(state);
  state.resolve = async () => {
    throw new Error("controlled-current-resolver-failure");
  };
  await choose("system");
  assert.deepEqual(unhandled, []);
  assert.deepEqual(state.updates, []);
  await choose("en-US");
  assert.deepEqual(state.updates, [{ locale: "en-US", localePreference: "en-US" }]);
});

test("actual old-slot resolver rejects after same-access navigation without writing the new Host view", async () => {
  const state = fixture();
  await renderSurface(state);
  const pending = deferred();
  state.resolve = () => pending.promise;
  await choose("system");
  state.slotCurrent = false;
  state.resolve = async () => "zh-CN";
  state.slot = source.createMobileRootSlot(
    state.access,
    { workspaceKey: "/source-fixture", revision: 1 },
    "source-window",
    { getSystemLocale: state.resolveSystemLocale },
    {},
    () => true,
  );
  await renderSurface(state);
  pending.resolve("zh-CN");
  await settle();
  assert.deepEqual(state.updates, []);
  assert.deepEqual(state.broadcasts, []);
  assert.deepEqual(unhandled, []);
  await choose("en-US");
  assert.deepEqual(state.updates, [{ locale: "en-US", localePreference: "en-US" }]);
});

test("actual RootSurface refuses an invalid slot before starting the Host resolver", async () => {
  const state = fixture();
  state.settings = { locale: "en-US", localePreference: "en-US" };
  await renderSurface(state);
  const calls = state.resolverCalls;
  state.slotCurrent = false;
  await choose("system");
  assert.equal(state.resolverCalls, calls);
  assert.deepEqual(state.updates, []);
  assert.deepEqual(state.broadcasts, []);
  assert.deepEqual(unhandled, []);
});

test("actual initial setting get rejection is handled and a later explicit language still persists", async () => {
  const state = fixture();
  state.getFailure = true;
  await renderSurface(state);
  assert.deepEqual(unhandled, []);
  assert.deepEqual(state.updates, []);
  await choose("en-US");
  assert.deepEqual(state.updates, [{ locale: "en-US", localePreference: "en-US" }]);
});

test("actual initial resolver rejection is handled without the prefer-service shortcut", async () => {
  const state = fixture();
  state.resolve = async () => {
    throw new Error("controlled-initial-resolver-failure");
  };
  await renderProvider(state, state.resolveSystemLocale, false);
  assert.equal(state.resolverCalls, 1);
  assert.deepEqual(state.updates, []);
  assert.deepEqual(state.broadcasts, []);
  assert.deepEqual(unhandled, []);
  await choose("en-US");
  assert.deepEqual(state.updates, [{ locale: "en-US", localePreference: "en-US" }]);
});

test("actual initial Host system rejection keeps the Host seed and never writes phone locale", async () => {
  const state = fixture();
  state.resolve = async () => {
    throw new Error("controlled-initial-system-failure");
  };
  await renderSurface(state);
  assert.equal(state.resolverCalls, 1);
  assert.deepEqual(view(), { locale: "zh-CN", preference: "system" });
  assert.deepEqual(state.updates, []);
  assert.deepEqual(unhandled, []);
});

test("actual broadcast rejection is handled while the same explicit setting update continues", async () => {
  const state = fixture();
  await renderSurface(state);
  state.broadcastFailure = true;
  await choose("en-US");
  assert.deepEqual(state.updates, [{ locale: "en-US", localePreference: "en-US" }]);
  assert.deepEqual(unhandled, []);
});

test("actual old equal-language broadcast completion cannot clear the new pending local echo guard", async () => {
  const state = fixture();
  await renderSurface(state);
  const first = deferred();
  const second = deferred();
  let sends = 0;
  state.broadcastGate = () => (++sends === 1 ? first.promise : second.promise);
  await choose("en-US");
  await choose("en-US");
  first.resolve();
  await settle();
  const writes = state.localWrites.length;
  await act(async () => {
    state.listener({ channel: "state:locale", payload: state.broadcasts[1].payload });
  });
  assert.equal(state.localWrites.length, writes);
  second.resolve();
  await settle();
  assert.deepEqual(unhandled, []);
});
