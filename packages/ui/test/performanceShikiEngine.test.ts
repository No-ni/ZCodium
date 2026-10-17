import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  tokenize: vi.fn(),
  loadTheme: vi.fn(),
  register: vi.fn(),
  error: vi.fn(),
}));
vi.mock("shiki", () => ({
  bundledLanguages: { javascript: {}, typescript: {}, python: {} },
  bundledLanguagesInfo: [{ id: "javascript", aliases: ["js"] }],
  createHighlighter: mocks.create,
}));
vi.mock("@/logger.js", () => ({ logger: { error: mocks.error } }));
vi.mock("@/lib/memoryDiagnostics.js", () => ({
  uiMemoryDiagnosticsRegistry: { register: mocks.register },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.loadTheme.mockResolvedValue(undefined);
  mocks.tokenize.mockImplementation((code: string, options: { lang: string; theme: string }) => ({
    fg: options.theme,
    tokens: [[{ content: code, color: options.theme }]],
  }));
  mocks.create.mockImplementation(async (options: { langs: string[]; themes: string[] }) => {
    // 每个 fake 引擎有独立语法/主题表，避免全局 Set 掩盖跨语言串用。
    const languages = new Set(options.langs);
    const themes = new Set(options.themes);
    return {
      getLoadedLanguages: () => [...languages],
      getLoadedThemes: () => [...themes],
      loadTheme: async (theme: string) => {
        await mocks.loadTheme(options.langs[0], theme);
        themes.add(theme);
      },
      codeToTokens: (code: string, opts: { lang: string; theme: string }) => {
        expect(languages.has(opts.lang)).toBe(true);
        expect(themes.has(opts.theme)).toBe(true);
        return mocks.tokenize(code, opts);
      },
    };
  });
});

async function setup() {
  const { highlightCode } = await import("@/lib/shikiHighlighter.js");
  const complete = (
    code: string,
    language = "js",
    theme: "github-dark" | "github-light" = "github-dark",
  ) =>
    new Promise<NonNullable<ReturnType<typeof highlightCode>>>((resolve) => {
      highlightCode(code, language, theme, resolve);
    });
  const counters = () => mocks.register.mock.calls[0]![1]();
  return { complete, highlightCode, counters };
}

describe("Shiki engine ownership by language", () => {
  it("shares each language engine and theme flight across distinct concurrent code", async () => {
    const { complete, counters } = await setup();
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        complete(
          "const value = " + index,
          index % 3 === 0 ? "typescript" : "js",
          index % 2 === 0 ? "github-dark" : "github-light",
        ),
      ),
    );
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.loadTheme).toHaveBeenCalledTimes(4);
    expect(mocks.tokenize).toHaveBeenCalledTimes(60);
    results.forEach((result, index) => {
      expect(result.fg).toBe(index % 2 === 0 ? "github-dark" : "github-light");
      expect(result.tokens[0]![0]!.content).toBe("const value = " + index);
    });
    expect(counters()).toMatchObject({ highlighters: 2, pending: 0, pendingResources: 0 });
    await complete("later", " JS ");
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.loadTheme).toHaveBeenCalledTimes(4);
  });

  it("waits for a theme while the old theme and other languages can finish", async () => {
    const { complete, counters } = await setup();
    await complete("warm");
    const gate = deferred();
    mocks.loadTheme.mockImplementationOnce(() => gate.promise);
    let completed = false;
    const slow = complete("slow", "js", "github-light").then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(counters().pendingResources).toBe(1));
    await Promise.all([
      complete("same language"),
      complete("other language", "python", "github-light"),
    ]);
    expect(completed).toBe(false);
    gate.resolve();
    await slow;
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(counters()).toMatchObject({ pending: 0, pendingResources: 0 });
  });

  it("retries a failed theme without discarding the working language engine", async () => {
    const { highlightCode, complete, counters } = await setup();
    await complete("warm");
    mocks.loadTheme.mockRejectedValueOnce(new Error("theme failed"));
    highlightCode("retry", "js", "github-light");
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1));
    expect(counters()).toMatchObject({ highlighters: 1, pending: 0, pendingResources: 0 });
    await complete("old theme");
    expect((await complete("retry", "js", "github-light")).fg).toBe("github-light");
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("retries failed initialization without dropping a different healthy language", async () => {
    const { complete, highlightCode, counters } = await setup();
    await complete("healthy", "python");
    mocks.create.mockRejectedValueOnce(new Error("language failed"));
    highlightCode("one", "js", "github-dark");
    highlightCode("two", "javascript", "github-light");
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(2));
    expect(counters()).toMatchObject({ highlighters: 1, pending: 0 });
    await Promise.all([
      complete("one"),
      complete("two", "js", "github-light"),
      complete("healthy again", "python"),
    ]);
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(counters()).toMatchObject({ highlighters: 2, pending: 0, pendingResources: 0 });
  });

  it("does not tokenize before language initialization completes", async () => {
    const { complete, counters } = await setup();
    const gate = deferred();
    const create = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementationOnce(async (options) => {
      await gate.promise;
      return create(options);
    });
    const pending = Promise.all([complete("one"), complete("two", "js", "github-light")]);
    await complete("independent", "python");
    expect(mocks.tokenize).toHaveBeenCalledTimes(1);
    gate.resolve();
    await pending;
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.tokenize).toHaveBeenCalledTimes(3);
    expect(counters()).toMatchObject({ highlighters: 2, pending: 0, pendingResources: 0 });
  });
});
