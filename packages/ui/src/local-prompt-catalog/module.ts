/** 本地推荐文案目录；只登记原数据与纯筛选函数，不创建运行时实例。 */
export const uiLocalPromptCatalogModule = {
  id: "ui-local-prompt-catalog",
  requires: ["ui"],
  provides: ["local-prompt-catalog"],
  publicEntrypoints: ["../v4/officeSuggestedPrompts.ts", "contract.ts"],
} as const;
