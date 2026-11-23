import type createPlugin from "tailwindcss/plugin";

/** 既有 lucide-colors.mjs 的默认导出；只在 Tailwind 构建阶段消费，没有运行时状态或 IO。 */
export type UiStyleBuildPlugin = ReturnType<typeof createPlugin>;
