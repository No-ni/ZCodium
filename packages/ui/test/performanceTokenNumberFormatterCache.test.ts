import { describe, expect, it } from "vitest";
import {
  formatCompactTokenNumber,
  formatModelContextWindowLabel,
} from "@/lib/tokenNumberFormat.js";

/**
 * 行为基准：按当前产品契约复述的旧实现（每次调用都新建 Intl.NumberFormat）。
 * 只用于输出等价对照，不进入生产代码。
 */
function referenceFormatCompactTokenNumber(
  locale: string,
  value: number,
  options: { maximumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  const maximumFractionDigits = options.maximumFractionDigits ?? 1;
  const absValue = Math.abs(value);

  return new Intl.NumberFormat(locale || undefined, {
    notation: absValue >= 1_000 ? "compact" : "standard",
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

/** 确定性伪随机数值语料（LCG），保证红/绿两次执行输入完全一致。 */
function seededValues(seed: number, count: number): number[] {
  let state = seed >>> 0;
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const scaled = (state % 100_000_000) / 1_000;
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    values.push(state % 2 === 0 ? scaled : -scaled);
  }
  return values;
}

const CORPUS_LOCALES = ["en-US", "zh-CN", "de-DE", "ja-JP", "", "fr"];
const CORPUS_VALUES = [
  0,
  -0,
  0.0001,
  1,
  42,
  999.4,
  999.5,
  1_000,
  1_049,
  1_000.5,
  -1_000,
  -42,
  12_345,
  1_000_000,
  1_500_000,
  2_500_000_000,
  9.5e20,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

describe("token 数字格式化输出等价（oracle：每次新建 formatter 的旧实现）", () => {
  it("结构化边界与伪随机语料逐位一致", () => {
    const randomValues = seededValues(202_610_311, 240);
    for (const locale of CORPUS_LOCALES) {
      for (const maximumFractionDigits of [0, 1, 2]) {
        for (const value of [...CORPUS_VALUES, ...randomValues]) {
          expect(formatCompactTokenNumber(locale, value, { maximumFractionDigits })).toBe(
            referenceFormatCompactTokenNumber(locale, value, { maximumFractionDigits }),
          );
        }
      }
      // 缺省 maximumFractionDigits = 1 也必须一致。
      for (const value of [...CORPUS_VALUES, ...randomValues]) {
        expect(formatCompactTokenNumber(locale, value)).toBe(
          referenceFormatCompactTokenNumber(locale, value),
        );
      }
    }
  });

  it("formatModelContextWindowLabel 固定 en-US 且忽略 locale", () => {
    for (const contextWindow of [512, 1_024, 4_000, 32_000, 400_000, 1_000_000, 128_000]) {
      for (const locale of ["zh-CN", "", "de-DE"]) {
        expect(formatModelContextWindowLabel(contextWindow, locale)).toBe(
          referenceFormatCompactTokenNumber("en-US", contextWindow),
        );
      }
      expect(formatModelContextWindowLabel(contextWindow)).toBe(
        referenceFormatCompactTokenNumber("en-US", contextWindow),
      );
    }
  });
});

describe("非法 locale 与非法 maximumFractionDigits 的异常 parity", () => {
  function outcomeOf(run: () => string): string {
    try {
      return `ok:${run()}`;
    } catch (error) {
      return `throw:${error instanceof Error ? error.constructor.name : "non-error"}`;
    }
  }

  it("空 locale 预热后，NUL 开头的非法 locale 仍必须 RangeError（键碰撞守卫）", () => {
    // 先走空串（系统默认）路径，再传入字面量 "\u0000system"：
    // 若缓存键把空串归一成 "\u0000system" 哨兵，两者会碰撞并吞掉构造器的 RangeError。
    expect(formatCompactTokenNumber("", 42)).toBe(referenceFormatCompactTokenNumber("", 42));
    expect(formatCompactTokenNumber("", 12_345)).toBe(
      referenceFormatCompactTokenNumber("", 12_345),
    );
    expect(() => formatCompactTokenNumber("\u0000system", 42)).toThrow(RangeError);
    expect(() => formatCompactTokenNumber("\u0000system", 12_345)).toThrow(RangeError);
    // 抛出不得污染缓存：合法调用必须继续返回与 oracle 一致的结果。
    expect(formatCompactTokenNumber("en-US", 42)).toBe(
      referenceFormatCompactTokenNumber("en-US", 42),
    );
  });

  it("非法 locale / 非法小数位的成败与异常类型逐项与 oracle 一致", () => {
    const invalidLocales = ["!!!", "\u0000system", "en-US-!!!"];
    const oddFractionDigits: number[] = [-1, 0, 1.5, 21, 100, Number.NaN, Number.POSITIVE_INFINITY];
    for (const locale of [...invalidLocales, "de-DE", ""]) {
      for (const maximumFractionDigits of oddFractionDigits) {
        for (const value of [42, -12_345]) {
          expect(
            outcomeOf(() => formatCompactTokenNumber(locale, value, { maximumFractionDigits })),
          ).toBe(
            outcomeOf(() =>
              referenceFormatCompactTokenNumber(locale, value, { maximumFractionDigits }),
            ),
          );
        }
      }
    }
  });
});

type NumberFormatConstructor = typeof Intl.NumberFormat;

/** 打点替换 Intl.NumberFormat 构造器，统计一次负载内的真实构造次数。 */
function countFormatterConstructions(run: () => void): number {
  const original = Intl.NumberFormat as unknown as NumberFormatConstructor;
  let constructions = 0;
  const patched = function countedNumberFormat(
    this: unknown,
    ...args: unknown[]
  ): Intl.NumberFormat {
    constructions += 1;
    return new (original as unknown as new (...inner: unknown[]) => Intl.NumberFormat)(...args);
  } as unknown as NumberFormatConstructor;
  Object.defineProperty(Intl, "NumberFormat", { value: patched, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(Intl, "NumberFormat", { value: original, configurable: true });
  }
  return constructions;
}

describe("token 数字格式化重复构造收敛", () => {
  it("6000 次格式化仅按互异配置构造 formatter", () => {
    // 负载使用与等价语料互不相同的 locale，避免旧实现下不存在的缓存预热干扰计数。
    // 4 个互异配置 = 2 locale × 2 记法；旧实现构造 6000 次，必须失败。
    const constructions = countFormatterConstructions(() => {
      for (let iteration = 0; iteration < 1_500; iteration += 1) {
        for (const locale of ["pl-PL", "sv-SE"]) {
          formatCompactTokenNumber(locale, 42);
          formatCompactTokenNumber(locale, 12_345);
        }
      }
    });
    expect(constructions).toBe(4);
    // 打点期间构造出的输出仍必须正确（构造器只被计数，不被替换语义）。
    expect(formatCompactTokenNumber("pl-PL", 12_345)).toBe(
      referenceFormatCompactTokenNumber("pl-PL", 12_345),
    );
  });

  it("缓存有界：插入 70 个互异 locale 后，最早 6 个被重建、较新配置保持命中", () => {
    // 该负载用 maximumFractionDigits=3 与全部既有语料（0/1/2）隔离出干净的配置族，
    // 使构造计数只反映本测试的插入与淘汰，不被其它测试的缓存残留干扰。
    const letters = "ABCDEFGHIJKLMNOPRSTUVWXYZ";
    const locales: string[] = [];
    outer: for (const first of letters) {
      for (const second of letters) {
        locales.push(`en-${first}${second}`);
        if (locales.length === 70) break outer;
      }
    }
    // 对照函数自身也构造 formatter；计数前取得对照输出，预算只统计生产调用。
    const oracleFresh = locales.map((locale) =>
      referenceFormatCompactTokenNumber(locale, 1_000, { maximumFractionDigits: 3 }),
    );
    const producedFresh: string[] = [];
    // 70 > 上限 64：按插入序 FIFO 后，缓存里该族应只剩最后 64 个（#6..#69，0 基）。
    const freshConstructions = countFormatterConstructions(() => {
      for (const locale of locales) {
        producedFresh.push(formatCompactTokenNumber(locale, 1_000, { maximumFractionDigits: 3 }));
      }
    });
    expect(freshConstructions).toBe(70);
    expect(producedFresh).toEqual(oracleFresh);

    const probes = [locales[69], ...locales.slice(0, 6), locales[12]];
    const oracleProbes = probes.map((locale) =>
      referenceFormatCompactTokenNumber(locale, 1_000, { maximumFractionDigits: 3 }),
    );
    const producedProbes: string[] = [];
    const observed = countFormatterConstructions(() => {
      for (const locale of probes) {
        producedProbes.push(formatCompactTokenNumber(locale, 1_000, { maximumFractionDigits: 3 }));
      }
    });
    // 探测顺序 = FIFO 语义证明：#69 仍命中（0 次）；#0..#5 已被逐出，各重建 1 次（6 次），
    // 重建插入依次逐出更老的 #6..#11；#12 未触及仍命中（0 次）。
    expect(observed).toBe(6);
    expect(producedProbes).toEqual(oracleProbes);
  });
});
