import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createHighlighter: vi.fn(),
  codeToTokens: vi.fn(),
  register: vi.fn(),
  error: vi.fn(),
}));
vi.mock("shiki", () => ({
  bundledLanguages: { javascript: {}, typescript: {}, log: {} },
  bundledLanguagesInfo: [{ id: "javascript", aliases: ["js"] }],
  createHighlighter: mocks.createHighlighter,
}));
vi.mock("@/logger.js", () => ({ logger: { error: mocks.error } }));
vi.mock("@/lib/memoryDiagnostics.js", () => ({
  uiMemoryDiagnosticsRegistry: { register: mocks.register },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.codeToTokens.mockReset().mockImplementation((code: string) => ({
    fg: "#fff",
    tokens: [[{ content: code }]],
  }));
  mocks.createHighlighter.mockReset().mockResolvedValue({
    getLoadedLanguages: () => ["javascript", "typescript", "log"],
    getLoadedThemes: () => ["github-dark", "github-light"],
    codeToTokens: mocks.codeToTokens,
  });
});

async function setup() {
  const { highlightCode } = await import("@/lib/shikiHighlighter.js");
  const complete = (code: string, language = "javascript", theme = "github-dark" as const) =>
    new Promise<NonNullable<ReturnType<typeof highlightCode>>>((resolve) => {
      highlightCode(code, language, theme, resolve);
    });
  return { highlightCode, complete };
}

describe("frontend highlight work and retained memory", () => {
  it("tokenizes one pending identity once and delivers the same result to 100 callers", async () => {
    const { complete, highlightCode } = await setup();
    const results = await Promise.all(Array.from({ length: 100 }, () => complete("const a = 1;")));
    expect(mocks.codeToTokens).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result === results[0])).toBe(true);
    const callback = vi.fn();
    expect(highlightCode("const a = 1;", "js", "github-dark", callback)).toBe(results[0]);
    expect(callback).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledWith(results[0]);
  });

  it("distinguishes equal-length code changes outside the first and last 100 characters", async () => {
    const { complete } = await setup();
    const prefix = "a".repeat(120);
    const suffix = "z".repeat(120);
    const first = await complete(`${prefix}111${suffix}`);
    const second = await complete(`${prefix}222${suffix}`);
    expect(second.tokens[0]![0]!.content).toBe(`${prefix}222${suffix}`);
    expect(second).not.toBe(first);
    expect(mocks.codeToTokens).toHaveBeenCalledTimes(2);
  });

  it("isolates language and theme while reusing a normalized language alias", async () => {
    const { complete, highlightCode } = await setup();
    const js = await complete("value");
    expect(highlightCode("value", " JS ", "github-dark")).toBe(js);
    await complete("value", "typescript");
    await new Promise((resolve) => highlightCode("value", "js", "github-light", resolve));
    expect(mocks.codeToTokens).toHaveBeenCalledTimes(3);
  });

  it("evicts least recently used code after the entry limit", async () => {
    const { complete, highlightCode } = await setup();
    for (let i = 0; i < 128; i++) await complete(`code ${i}`);
    expect(highlightCode("code 0", "js", "github-dark")).not.toBeNull();
    await complete("new code");
    expect(highlightCode("code 0", "js", "github-dark")).not.toBeNull();
    expect(highlightCode("code 1", "js", "github-dark")).toBeNull();
    await Promise.resolve();
    const counters = mocks.register.mock.calls[0]![1]();
    expect(counters.tokensCache).toBeLessThanOrEqual(128);
  });

  it("bounds total source characters even when the entry count is small", async () => {
    const { complete, highlightCode } = await setup();
    const codes = Array.from({ length: 24 }, (_, index) => `${index}:` + "x".repeat(110_000));
    for (const code of codes) await complete(code);
    expect(highlightCode(codes.at(-1)!, "js", "github-dark")).not.toBeNull();
    expect(highlightCode(codes[0]!, "js", "github-dark")).toBeNull();
    await Promise.resolve();
    const counters = mocks.register.mock.calls[0]![1]();
    expect(counters.tokensCacheChars).toBeLessThanOrEqual(2_000_000);
  });

  it("delivers oversized token results without retaining them", async () => {
    const { complete, highlightCode } = await setup();
    mocks.codeToTokens.mockReturnValue({
      tokens: [Array.from({ length: 100_001 }, () => ({ content: "" }))],
    });
    const result = await complete("many tokens");
    expect(result.tokens[0]).toHaveLength(100_001);
    expect(highlightCode("many tokens", "js", "github-dark")).toBeNull();
    await Promise.resolve();
    const counters = mocks.register.mock.calls[0]![1]();
    expect(counters.tokensCache).toBe(0);
  });

  it("retries after failed highlighter initialization instead of retaining rejection", async () => {
    const { complete, highlightCode } = await setup();
    mocks.createHighlighter.mockRejectedValueOnce(new Error("load failed"));
    highlightCode("retry", "js", "github-dark");
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1));
    const result = await complete("retry");
    expect(result.tokens[0]![0]!.content).toBe("retry");
    expect(mocks.createHighlighter).toHaveBeenCalledTimes(2);
  });

  it("retries tokenize failures and bypasses the engine for plain text", async () => {
    const { complete, highlightCode } = await setup();
    expect(highlightCode("raw\ntext", "text")?.tokens.map((line) => line[0]?.content)).toEqual([
      "raw",
      "text",
    ]);
    expect(mocks.createHighlighter).not.toHaveBeenCalled();
    mocks.codeToTokens.mockImplementationOnce(() => {
      throw new Error("tokenize failed");
    });
    highlightCode("retry", "js", "github-dark");
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1));
    expect((await complete("retry")).tokens[0]![0]!.content).toBe("retry");
  });

  it("bounds combined token storage and does not retain an oversized source", async () => {
    const { complete, highlightCode } = await setup();
    mocks.codeToTokens.mockReturnValue({
      tokens: [Array.from({ length: 60_000 }, () => ({ content: "" }))],
    });
    await complete("first");
    const recent = await complete("recent");
    expect(highlightCode("recent", "js", "github-dark")).toBe(recent);
    expect(highlightCode("first", "js", "github-dark") === null).toBe(true);
    await complete("first");
    const oversized = "x".repeat(2_000_001);
    await complete(oversized);
    const count = mocks.codeToTokens.mock.calls.length;
    await complete(oversized);
    expect(mocks.codeToTokens).toHaveBeenCalledTimes(count + 1);
    const counters = mocks.register.mock.calls[0]![1]();
    expect(counters.tokensCacheTokens).toBeLessThanOrEqual(100_000);
    expect(counters.tokensCacheChars).toBeLessThanOrEqual(2_000_000);
  });

  it("merges preloads without callbacks and isolates a failing subscriber", async () => {
    const { complete, highlightCode } = await setup();
    highlightCode("preload", "js", "github-dark");
    highlightCode("preload", "js", "github-dark", () => {
      throw new Error("subscriber failed");
    });
    const result = await complete("preload");
    expect(result.tokens[0]![0]!.content).toBe("preload");
    expect(mocks.codeToTokens).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(mocks.register.mock.calls[0]![1]().pending).toBe(0);
  });
});
