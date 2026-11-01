export function formatCompactTokenNumber(
  locale: string,
  value: number,
  options: { maximumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  const maximumFractionDigits = options.maximumFractionDigits ?? 1;
  const absValue = Math.abs(value);

  // token 数值仍应走本地化 compact；中文展示万/亿，英文展示 K/M/B。
  // 之前为了修 Start Plan 的英文 long unit 误把所有 locale 都强制成 K/M/B。
  return getSharedNumberFormat(
    locale,
    absValue >= 1_000 ? "compact" : "standard",
    maximumFractionDigits,
  ).format(value);
}

export function formatModelContextWindowLabel(contextWindow: number, _locale = "en-US"): string {
  // 模型列表的容量 badge 是技术规格，不应随中文 locale 变成“万/亿”。
  return formatCompactTokenNumber("en-US", contextWindow);
}

// 同一渲染配置反复构造格式化器会重复解析 locale 和选项；复用固定配置，淘汰只影响准备次数。
// 失败构造不入缓存，保留原有参数错误；模块独占这份最多 64 项的派生缓存。
const MAX_CACHED_NUMBER_FORMATTERS = 64;
const numberFormatterCache = new Map<string, Intl.NumberFormat>();

function getSharedNumberFormat(
  locale: string,
  notation: "compact" | "standard",
  maximumFractionDigits: number,
): Intl.NumberFormat {
  // 数组编码避免非法 locale 与系统默认 locale 的键碰撞，不能通过缓存命中跳过原来的 RangeError。
  const cacheKey = JSON.stringify([locale || "", notation, maximumFractionDigits]);
  const cached = numberFormatterCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.NumberFormat(locale || undefined, {
    notation,
    maximumFractionDigits,
    minimumFractionDigits: 0,
  });
  if (numberFormatterCache.size >= MAX_CACHED_NUMBER_FORMATTERS) {
    // Map 迭代顺序即插入顺序：淘汰最早插入的一项，保证异常调用方持续喂新 locale 时内存有界。
    const oldestKey = numberFormatterCache.keys().next().value;
    if (oldestKey !== undefined) {
      numberFormatterCache.delete(oldestKey);
    }
  }
  numberFormatterCache.set(cacheKey, formatter);
  return formatter;
}
