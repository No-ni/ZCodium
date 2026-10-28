/**
 * office-runtime 对外契约：内置文档插件（documents / pdf / presentations / spreadsheets）如何声明
 * 查看面板，以及在插件根目录运行 `node ../office-runtime/scripts/build.mjs` 后保证产出什么。
 * 面板与 MCP 工具的运行时契约见 src/contract.ts 与 src/CONTRACT.md。
 */
import type { DocKind } from "#office/contract.ts";

export type { DocKind };

/** 插件包 package.json 的 "office" 字段：面板标题与该插件打开的格式。 */
export interface OfficePluginConfig {
  title: { en: string; "zh-CN": string };
  kinds: readonly DocKind[];
}

/**
 * 构建后在插件根目录下必定存在的最小产物。公共 seed、SEA 与桌面 staging 登记这些路径并拒绝
 * 缺件，但分发必须递归保留完整 dist（workers/WASM/fonts/许可），不能将本表当复制白名单。
 * 实际接入验证与未执行的产品发行边界见本项 spec。
 */
export const OFFICE_RUNTIME_OUTPUTS = [
  "dist/server.mjs",
  "dist/ui/assets.json",
  "dist/ui/panel.html",
  "dist/LICENSE",
  "dist/THIRD_PARTY_NOTICES.txt",
] as const;

export interface OfficeRuntimeContract {
  /** 插件声明的面板配置；插件名取自其 .zcodium-plugin/plugin.json，决定 MCP 服务与 ui:// 资源地址。 */
  config: OfficePluginConfig;
  /** 构建保证产出的文件，相对插件根目录。 */
  outputs: typeof OFFICE_RUNTIME_OUTPUTS;
}
