import { describe, expect, it, vi } from "vitest";
import { createSessionFacade } from "../src/app/session-facade.js";

describe("session facade shutdown", () => {
  it.each(["runtime_work", "browser_session"] as const)(
    "logs pending %s once without finishing shutdown",
    async (resource) => {
      vi.useFakeTimers();
      const gate = Promise.withResolvers<void>();
      const warn = vi.fn();
      const drain = vi.fn(() => (resource === "runtime_work" ? gate.promise : Promise.resolve()));
      const browser = vi.fn(() =>
        resource === "browser_session" ? gate.promise : Promise.resolve(),
      );
      const facade = createSessionFacade({
        configResult: { config: { ui: { locale: "en" } } },
        runtime: { beginShutdown() {}, closeOwnedWork: drain, closeBrowserSession: browser },
        ownsSessionStore: false,
        ownsExecutionPort: false,
        ownsMcpPort: false,
      loggerFactory: {},
        logger: { warn },
      } as never);
      let settled = false;
      const close = facade.close!().then(() => {
        settled = true;
      });
      const duplicate = facade.close!();
      try {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(warn).toHaveBeenCalledWith(
          "Session resources are still closing",
          expect.objectContaining({
            event: "session.resource_close.slow",
            pendingResources: [resource],
          }),
        );
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(warn).toHaveBeenCalledTimes(1);
        gate.resolve();
        await Promise.all([close, duplicate]);
        expect(drain).toHaveBeenCalledTimes(1);
        expect(browser).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        gate.resolve();
        await Promise.allSettled([close, duplicate]);
        vi.useRealTimers();
      }
    },
  );

  it("keeps actual close pending beyond the former six-second budget", async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const closed: string[] = [];
    const warn = vi.fn();
    let settled = false;
    const facade = createSessionFacade({
      configResult: {config: {ui: {locale: "en"}}},
      runtime: {beginShutdown() {}, closeOwnedWork: async () => {}, closeBrowserSession: () => gate.promise},
      ownsExecutionPort: true,
      executionPort: {close: () => {closed.push("execution");}},
      ownsSessionStore: true,
      sessionStore: {close: () => {closed.push("store");}},
      ownsMcpPort: false,
      loggerFactory: {},
      logger: { warn } as never,
    } as never);
    const close = facade.close!();
    void close.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(6001);
      expect(settled).toBe(false);
      expect(closed).toEqual(["execution"]);
      gate.resolve();
      await close;
      expect(closed).toEqual(["execution", "store"]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await close.catch(() => {});
      vi.useRealTimers();
    }
  });

  it("shares actual facade shutdown while owned work is still draining", async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const browser = vi.fn(async () => {});
    const drain = vi.fn(() => gate.promise);
    const facade = createSessionFacade({
      configResult: { config: { ui: { locale: "en" } } },
      runtime: { beginShutdown() {}, closeOwnedWork: drain, closeBrowserSession: browser },
      ownsSessionStore: false,
      ownsExecutionPort: false,
      ownsMcpPort: false,
      loggerFactory: {},
      logger: { warn: vi.fn() },
    } as never);
    let settled = false;
    const close = facade.close!();
    const duplicate = facade.close!();
    void close.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(6001);
      expect(settled).toBe(false);
      expect(browser).not.toHaveBeenCalled();
      gate.resolve();
      await Promise.all([close, duplicate]);
      expect(drain).toHaveBeenCalledOnce();
      expect(browser).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await Promise.allSettled([close, duplicate]);
      vi.useRealTimers();
    }
  });

  it("registers the close promise before synchronous shutdown callbacks can reenter", async () => {
    let reentered = false;
    const drain = vi.fn(async () => {});
    const facade = createSessionFacade({
      configResult: { config: { ui: { locale: "en" } } },
      runtime: {
        beginShutdown() {
          if (!reentered) {
            reentered = true;
            void facade.close!();
          }
        },
        closeOwnedWork: drain,
        closeBrowserSession: async () => {},
      },
      ownsSessionStore: false,
      ownsExecutionPort: false,
      ownsMcpPort: false,
      loggerFactory: {},
      logger: { warn: vi.fn() },
    } as never);
    await facade.close!();
    expect(drain).toHaveBeenCalledOnce();
  });

  it("isolates close failures and still closes the session store", async () => {
    const events: string[] = [];
    const warn = vi.fn();

    const facade = createSessionFacade({
        configResult: {config: {ui: {locale: "en"}}},
        runtime: {
          beginShutdown: () => events.push("admission_closed"),
          closeOwnedWork: async () => {},
          closeBrowserSession: async () => {
          throw new Error("browser failed");
        },
        },
        ownsExecutionPort: true,
        executionPort: {close: async () => events.push("execution_closed")},
        ownsMcpPort: true,
        mcpPort: {close: async () => {
          throw new Error("mcp failed");
        }},
        ownsSessionStore: true,
        sessionStore: {close: () => events.push("store_closed")},
        loggerFactory: {},
        logger: { warn } as never,
      } as never);
    await expect(facade.close!()).rejects.toBeInstanceOf(AggregateError);

    // facade 的准入关闭和资源释放前复核均须先发生；重复 beginShutdown 沿用既有幂等契约。
    expect(events).toEqual(["admission_closed", "admission_closed", "execution_closed", "store_closed"]);
    expect(warn).toHaveBeenCalledWith(
      "Session resource close failed",
      expect.objectContaining({ resource: "mcp" }),
    );
  });
});
