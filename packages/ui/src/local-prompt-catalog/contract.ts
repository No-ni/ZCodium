/** 仅供本地展示的推荐文案；来源与安装资格由现有插件服务裁决。 */
export type LocalPromptCatalog = Pick<
  typeof import("../v4/officeSuggestedPrompts.js"),
  "officeSuggestedPrompts" | "defaultSuggestedPrompts" | "getRecommendedPromptPool"
>;
