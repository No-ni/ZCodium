import type { UiStyleBuildPlugin } from "./contract.js";

/** 仅展示 Tailwind 对既有默认导出的消费；生产入口仍是 styles.css 的 @plugin。 */
export function exampleUiStyleBuild(plugin: UiStyleBuildPlugin): { plugins: UiStyleBuildPlugin[] } {
  return { plugins: [plugin] };
}
