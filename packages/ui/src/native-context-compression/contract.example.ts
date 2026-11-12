import type { NativeContextTab } from "./contract.js";

/** 页签顺序与两个入口共用同一组件契约。 */
export const NATIVE_CONTEXT_TABS: readonly NativeContextTab[] = [
  "overview",
  "trends",
  "records",
  "parameters",
];
