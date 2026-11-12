import { matchToolPattern } from "acp-kernel";
import type {
  NativeContextPolicy,
  NativeContextResolvedToolProtection,
} from "@zcode/shared/native-context-compression";

/** 使用和内核相同的 matcher 展示 Runtime 注册表实际工具，不在表单重建规则。 */
export function resolvedNativeToolProtection(
  names: readonly string[],
  policy: NativeContextPolicy,
): NativeContextResolvedToolProtection {
  const { history, tools } = policy.parameters;
  const matches = (name: string, patterns: readonly string[]) =>
    patterns.some((pattern) => matchToolPattern(name, pattern));
  const actual = [...new Set(names)].filter((name) => name.length > 0 && name.length <= 512).sort();
  return {
    total: actual.length,
    items: actual
      .slice(0, 200)
      .map((name) => ({
        name,
        protected: matches(name, history.protectedTools),
        latest: matches(name, history.protectedLatestTools),
        earlyFold:
          matches(name, history.earlyFoldTools) && !matches(name, history.preserveRecentTools),
        preserveRecent: matches(name, history.preserveRecentTools),
        referenceExcluded: matches(name, tools.reference.excludeTools),
        distillExcluded: matches(name, tools.distill.excludeTools),
      })),
  };
}
