import assert from "node:assert/strict";
import { roundMs, waitForFixture } from "./terminal-render-browser.mjs";

async function prepareInputScenario(page) {
  const input = page.getByRole("textbox", { name: "Responsiveness probe" });
  await input.fill("");
  await page.waitForFunction(
    () => document.querySelector("[data-input-probe-echo]")?.textContent === "",
    undefined,
    { timeout: 60_000 },
  );
  await page.evaluate(() => {
    window.__terminalLongTaskObserver?.disconnect();
    window.__terminalEventObserver?.disconnect();

    if (!window.__terminalInputCaptureInstalled) {
      window.__terminalInputCaptureInstalled = true;
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "Enter" && event.key !== "x") return;
          window.__terminalInputKeyCaptures.push({
            key: event.key,
            altKey: event.altKey,
            timeStamp: event.timeStamp,
            observedAt: performance.now(),
          });
        },
        true,
      );
    }

    window.__terminalInputKeyCaptures = [];
    window.__terminalEventTimings = [];
    window.__terminalLongTaskEntries = [];
    window.__terminalEventTimingSupported = false;
    window.__terminalLongTaskSupported = false;

    if (typeof PerformanceObserver !== "undefined") {
      try {
        window.__terminalLongTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__terminalLongTaskEntries.push({
              startTime: entry.startTime,
              duration: entry.duration,
            });
          }
        });
        window.__terminalLongTaskObserver.observe({ type: "longtask" });
        window.__terminalLongTaskSupported = true;
      } catch {
        window.__terminalLongTaskObserver?.disconnect();
        window.__terminalLongTaskObserver = null;
      }

      if (PerformanceObserver.supportedEntryTypes?.includes("event")) {
        try {
          window.__terminalEventObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              window.__terminalEventTimings.push({
                name: entry.name,
                startTime: entry.startTime,
                processingStart: entry.processingStart,
                processingEnd: entry.processingEnd,
                duration: entry.duration,
                interactionId: entry.interactionId,
              });
            }
          });
          window.__terminalEventObserver.observe({
            type: "event",
            buffered: false,
            durationThreshold: 16,
          });
          window.__terminalEventTimingSupported = true;
        } catch {
          window.__terminalEventObserver?.disconnect();
          window.__terminalEventObserver = null;
        }
      }
    }
  });
  await input.focus();
  return page.evaluate(() => {
    window.performanceChatCode.inputEvents.length = 0;
    window.__terminalInputKeyCaptures.length = 0;
    window.__terminalEventTimings.length = 0;
    window.__terminalLongTaskEntries.length = 0;
    const startedAt = performance.now();
    window.__terminalInputStartedAt = startedAt;
    return {
      timeOrigin: performance.timeOrigin,
      startedAt,
      eventTimingSupported: window.__terminalEventTimingSupported,
      longTaskSupported: window.__terminalLongTaskSupported,
    };
  });
}

async function runInputScenario(page, session, scenario, prepared) {
  const isHistory = scenario === "history";
  const expectedMeasureName = isHistory ? "history-reparent" : "terminal";
  const requestedTimestampEpochMs = Date.now();
  const timestamp = requestedTimestampEpochMs / 1000;
  const keyDownCommands = [
    session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      modifiers: isHistory ? 1 : 0,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      timestamp,
    }),
    session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "x",
      code: "KeyX",
      modifiers: 0,
      windowsVirtualKeyCode: 88,
      nativeVirtualKeyCode: 88,
      text: "x",
      unmodifiedText: "x",
      timestamp,
    }),
  ];
  await Promise.all(keyDownCommands);

  const releaseTimestamp = Date.now() / 1000;
  const keyUpCommands = [
    session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      modifiers: isHistory ? 1 : 0,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      timestamp: releaseTimestamp,
    }),
    session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "x",
      code: "KeyX",
      modifiers: 0,
      windowsVirtualKeyCode: 88,
      nativeVirtualKeyCode: 88,
      timestamp: releaseTimestamp,
    }),
  ];
  if (isHistory) {
    keyUpCommands.push(
      session.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Alt",
        code: "AltLeft",
        modifiers: 0,
        windowsVirtualKeyCode: 18,
        nativeVirtualKeyCode: 18,
        timestamp: releaseTimestamp,
      }),
    );
  }
  await Promise.all(keyUpCommands);

  await page.waitForFunction(
    (measureName) => {
      const echo = document.querySelector("[data-input-probe-echo]");
      const api = window.performanceChatCode;
      return (
        echo?.textContent === "x" &&
        api.inputEvents.some((event) => event.key === "x" && event.type === "commit") &&
        api.measures.some((measure) => measure.name === measureName)
      );
    },
    expectedMeasureName,
    { timeout: 60_000 },
  );
  await page.evaluate(
    () =>
      new Promise((resolveFrames) => {
        requestAnimationFrame(() => requestAnimationFrame(resolveFrames));
      }),
  );

  const pageData = await page.evaluate((measureName) => {
    for (const entry of window.__terminalLongTaskObserver?.takeRecords() ?? []) {
      window.__terminalLongTaskEntries.push({
        startTime: entry.startTime,
        duration: entry.duration,
      });
    }
    for (const entry of window.__terminalEventObserver?.takeRecords() ?? []) {
      window.__terminalEventTimings.push({
        name: entry.name,
        startTime: entry.startTime,
        processingStart: entry.processingStart,
        processingEnd: entry.processingEnd,
        duration: entry.duration,
        interactionId: entry.interactionId,
      });
    }
    window.__terminalLongTaskObserver?.disconnect();
    window.__terminalEventObserver?.disconnect();

    const api = window.performanceChatCode;
    const measures = [...api.measures];
    const longTaskEntries = window.__terminalLongTaskEntries
      .filter((entry) => entry.startTime >= window.__terminalInputStartedAt)
      .map((entry) => ({
        startTimeMs: entry.startTime,
        durationMs: entry.duration,
      }));
    return {
      echo: document.querySelector("[data-input-probe-echo]")?.textContent ?? "",
      inputEvents: [...api.inputEvents],
      keyCaptures: [...window.__terminalInputKeyCaptures],
      eventTimings: [...window.__terminalEventTimings],
      eventTimingSupported: window.__terminalEventTimingSupported,
      longTaskSupported: window.__terminalLongTaskSupported,
      longTaskEntries,
      measures,
      transitionMeasure: measures.find((measure) => measure.name === measureName) ?? null,
    };
  }, expectedMeasureName);

  assert.equal(pageData.echo, "x");
  assert.deepEqual(
    pageData.inputEvents.map(({ key, type }) => ({ key, type })),
    [
      { key: "Enter", type: "keydown" },
      { key: "x", type: "keydown" },
      { key: "x", type: "commit" },
    ],
  );
  assert.ok(pageData.transitionMeasure, expectedMeasureName);

  const timestampChecks = pageData.keyCaptures.map((event) => {
    const eventEpochMs = prepared.timeOrigin + event.timeStamp;
    const skewMs = roundMs(eventEpochMs - requestedTimestampEpochMs);
    return {
      key: event.key,
      altKey: event.altKey,
      eventTimeStampMs: roundMs(event.timeStamp),
      observedDelayMs: roundMs(event.observedAt - event.timeStamp),
      eventEpochMs: roundMs(eventEpochMs),
      requestedTimestampEpochMs,
      skewMs,
      withinTolerance: Math.abs(skewMs) <= 25,
    };
  });
  const timestampRespected =
    timestampChecks.length === 2 && timestampChecks.every((event) => event.withinTolerance);
  const inputEvents = pageData.inputEvents;
  return {
    scenario,
    requestedTimestampEpochMs,
    timestampValidation: {
      toleranceMs: 25,
      respected: timestampRespected,
      events: timestampChecks,
    },
    inputEvents,
    inputHandlingDelayMs: {
      enterKeydownMs: timestampRespected
        ? (inputEvents.find((event) => event.key === "Enter" && event.type === "keydown")
            ?.delayMs ?? null)
        : null,
      xKeydownMs: timestampRespected
        ? (inputEvents.find((event) => event.key === "x" && event.type === "keydown")?.delayMs ??
          null)
        : null,
      xEchoCommitMs: timestampRespected
        ? (inputEvents.find((event) => event.key === "x" && event.type === "commit")?.delayMs ??
          null)
        : null,
    },
    keyCaptures: pageData.keyCaptures,
    eventTimingSupported: pageData.eventTimingSupported,
    eventTimings: pageData.eventTimings.map((entry) => ({
      ...entry,
      inputDelayMs:
        typeof entry.processingStart === "number"
          ? roundMs(entry.processingStart - entry.startTime)
          : null,
      processingMs:
        typeof entry.processingEnd === "number" && typeof entry.processingStart === "number"
          ? roundMs(entry.processingEnd - entry.processingStart)
          : null,
      durationMs: roundMs(entry.duration),
    })),
    longTaskSupported: pageData.longTaskSupported,
    longTaskEntries: pageData.longTaskEntries.map((entry) => ({
      startTimeMs: roundMs(entry.startTimeMs),
      durationMs: roundMs(entry.durationMs),
    })),
    longTasksMs: pageData.longTaskEntries.map((entry) => roundMs(entry.durationMs)),
    transitionMeasure: pageData.transitionMeasure,
    criticalMeasures: pageData.measures.filter((measure) =>
      ["cold-mount", "terminal", "history-reparent"].includes(measure.name),
    ),
  };
}

export async function runInputPageTrial({
  context,
  baseUrl,
  fixturePath,
  blockedRequests,
  pageErrors,
  variant,
  trial,
}) {
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(60_000);
  const origin = new URL(baseUrl).origin;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) {
      await route.continue();
    } else {
      blockedRequests.push(url.href);
      await route.abort();
    }
  });
  page.on("pageerror", (error) => pageErrors.push({ variant, trial, message: error.message }));

  let session;
  try {
    await page.goto(new URL(fixturePath + "?mode=streaming", baseUrl).href, {
      waitUntil: "load",
    });
    await waitForFixture(page);
    const initialState = await page.evaluate(() => {
      const root = document.querySelector("#live-tail-root");
      return {
        mode: document.querySelector("#fixture-controls")?.textContent?.includes("streaming"),
        sources: root?.querySelectorAll("[data-code-snippet-source]").length ?? 0,
        highlights: root?.querySelectorAll("[data-code-snippet-highlight]").length ?? 0,
      };
    });
    assert.equal(initialState.mode, true);
    assert.equal(initialState.sources, 240);
    assert.equal(initialState.highlights, 0);

    session = await context.newCDPSession(page);
    const terminalPrepared = await prepareInputScenario(page);
    const terminal = await runInputScenario(page, session, "terminal", terminalPrepared);

    await page.waitForFunction(
      () => Boolean(document.querySelector("#live-tail-root [data-code-snippet-highlight]")),
      undefined,
      { timeout: 60_000 },
    );
    await page.evaluate(
      () =>
        new Promise((resolveFrames) => {
          requestAnimationFrame(() => requestAnimationFrame(resolveFrames));
        }),
    );

    const historyPrepared = await prepareInputScenario(page);
    const history = await runInputScenario(page, session, "history", historyPrepared);
    return { variant, trial, initialState, terminal, history };
  } finally {
    try {
      await session?.detach();
    } finally {
      await page.close();
    }
  }
}
