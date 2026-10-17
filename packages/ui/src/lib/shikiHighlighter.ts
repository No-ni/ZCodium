import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki";
import { bundledLanguages, bundledLanguagesInfo, createHighlighter } from "shiki";
import { logger } from "@/logger.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

const bundledLanguageIds = new Set(Object.keys(bundledLanguages));
const bundledLanguageAliases = new Map(
  bundledLanguagesInfo.flatMap((info) =>
    (info.aliases ?? []).map((alias) => [alias, info.id] as const),
  ),
);
const FALLBACK_CODE_LANGUAGE: BundledLanguage = "log";
const PLAIN_TEXT_CODE_LANGUAGES = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "log",
  "output",
]);

export function shouldUseSyntaxHighlighting(language: string): boolean {
  const candidate = language.trim().toLowerCase();
  if (PLAIN_TEXT_CODE_LANGUAGES.has(candidate)) {
    return false;
  }

  return bundledLanguageIds.has(candidate) || bundledLanguageAliases.has(candidate);
}

function normalizeCodeLanguage(language: string): BundledLanguage {
  const candidate = language.trim().toLowerCase();
  if (!candidate) {
    return FALLBACK_CODE_LANGUAGE;
  }

  const alias = bundledLanguageAliases.get(candidate);
  if (alias && bundledLanguageIds.has(alias)) {
    return alias as BundledLanguage;
  }

  if (bundledLanguageIds.has(candidate)) {
    return candidate as BundledLanguage;
  }

  return FALLBACK_CODE_LANGUAGE;
}

const highlighterCache = new Map<
  BundledLanguage,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>();
const pendingResources = new Map<string, Promise<void>>();
const TOKEN_CACHE_MAX_ENTRIES = 128;
const TOKEN_CACHE_MAX_CHARS = 2_000_000;
const TOKEN_CACHE_MAX_TOKENS = 100_000;
const tokensCache = new Map<string, { result: TokenizedCode; tokenCount: number }>();
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();
let tokensCacheChars = 0;
let tokensCacheTokens = 0;
// 流式代码会产生大量不同版本；同时限制项数、源码字符与 token，避免长会话无界保留。
uiMemoryDiagnosticsRegistry.register("shiki", () => ({
  tokensCache: tokensCache.size,
  tokensCacheChars,
  tokensCacheTokens,
  pending: subscribers.size,
  highlighters: highlighterCache.size,
  pendingResources: pendingResources.size,
}));

function cacheCodeTokens(key: string, result: TokenizedCode): void {
  const tokenCount = result.tokens.reduce((total, line) => total + line.length, 0);
  if (key.length > TOKEN_CACHE_MAX_CHARS || tokenCount > TOKEN_CACHE_MAX_TOKENS) {
    return;
  }
  tokensCache.set(key, { result, tokenCount });
  tokensCacheChars += key.length;
  tokensCacheTokens += tokenCount;
  while (
    tokensCache.size > TOKEN_CACHE_MAX_ENTRIES ||
    tokensCacheChars > TOKEN_CACHE_MAX_CHARS ||
    tokensCacheTokens > TOKEN_CACHE_MAX_TOKENS
  ) {
    const oldest = tokensCache.entries().next().value;
    if (!oldest) break;
    tokensCache.delete(oldest[0]);
    tokensCacheChars -= oldest[0].length;
    tokensCacheTokens -= oldest[1].tokenCount;
  }
}

const getResolvedCodeTheme = (theme?: BundledTheme): BundledTheme => {
  if (theme) {
    return theme;
  }

  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "github-dark";
  }

  return "github-light";
};

const getCodeTokensCacheKey = (code: string, language: BundledLanguage, theme: BundledTheme) => {
  // 首尾采样无法区分中部等长编辑，必须用完整源码参与相等判断。
  return `${theme}:${language}:${code}`;
};
function loadHighlighterResource(key: string, load: () => Promise<void>): Promise<void> {
  const pending = pendingResources.get(key);
  if (pending) return pending;
  const flight = load().finally(() => {
    pendingResources.delete(key);
  });
  pendingResources.set(key, flight);
  return flight;
}

const getHighlighter = async (
  language: BundledLanguage,
  theme: BundledTheme,
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  // 按语言 × 主题建实例会重复常驻同一语法；同语言共用引擎并按需加载主题。
  // 不能跨语言合并：Shiki 的 lazy embedded grammar 会随已加载语言改变 Markdown 等输出。
  let highlighterPromise = highlighterCache.get(language);
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({ langs: [language], themes: [] }).catch(
      (error: unknown) => {
        highlighterCache.delete(language);
        throw error;
      },
    );
    highlighterCache.set(language, highlighterPromise);
  }
  const highlighter = await highlighterPromise;
  if (!highlighter.getLoadedThemes().includes(theme)) {
    await loadHighlighterResource(`${language}:${theme}`, () => highlighter.loadTheme(theme));
  }
  return highlighter;
};

const createRawCodeTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ],
  ),
});

// 带缓存的异步高亮入口；React 组件只应在 effect 中调用。
export const highlightCode = (
  code: string,
  language: string,
  theme?: BundledTheme,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null => {
  if (!shouldUseSyntaxHighlighting(language)) {
    // 文本/日志代码块没有语法高亮收益，却会在聊天流式渲染和历史恢复时进入
    // Shiki 的异步状态机。之前修掉了 render 阶段 setState，但这条纯文本路径仍可能把
    // CodeViewer 拖进 React #185；这里直接返回 raw tokens，避免启动高亮副作用。
    return createRawCodeTokens(code);
  }

  const resolvedTheme = getResolvedCodeTheme(theme);
  const resolvedLanguage = normalizeCodeLanguage(language);
  const tokensCacheKey = getCodeTokensCacheKey(code, resolvedLanguage, resolvedTheme);

  const cached = tokensCache.get(tokensCacheKey);
  if (cached) {
    tokensCache.delete(tokensCacheKey);
    tokensCache.set(tokensCacheKey, cached);
    // 缓存命中时也需要通知 effect，但不能同步触发 setState。
    // 历史消息恢复时大量代码块会在同一次提交后挂载；同步 callback 会把 cache-hit 变成嵌套更新，
    // 和 Streamdown 的重渲染叠在一起时容易触发 React #185。推迟到微任务后再交给幂等 setter。
    if (callback) {
      queueMicrotask(() => callback(cached.result));
    }
    return cached.result;
  }

  const pending = subscribers.get(tokensCacheKey);
  if (pending) {
    if (callback) pending.add(callback);
    return null;
  }
  // 即使没有订阅者也登记在途任务，多个组件同帧请求只执行一次 tokenize。
  subscribers.set(tokensCacheKey, new Set(callback ? [callback] : []));

  getHighlighter(resolvedLanguage, resolvedTheme)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages();
      const langToUse = availableLangs.includes(resolvedLanguage)
        ? resolvedLanguage
        : FALLBACK_CODE_LANGUAGE;

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        theme: resolvedTheme,
      });

      const tokenized: TokenizedCode = {
        bg: "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      };

      cacheCodeTokens(tokensCacheKey, tokenized);

      const subs = subscribers.get(tokensCacheKey);
      subscribers.delete(tokensCacheKey);
      if (subs) {
        for (const sub of subs) {
          try {
            sub(tokenized);
          } catch (error) {
            logger.error("[ShikiHighlighter] 高亮结果通知失败", error);
          }
        }
      }
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then), eslint-plugin-promise(prefer-await-to-callbacks)
    .catch((error) => {
      // Shiki 加载或 tokenize 失败，组件会停留在无高亮的 rawTokens 状态。
      logger.error(
        `[ShikiHighlighter] 代码高亮失败: language=${resolvedLanguage}, theme=${resolvedTheme}`,
        error,
      );
      subscribers.delete(tokensCacheKey);
    });

  return null;
};
