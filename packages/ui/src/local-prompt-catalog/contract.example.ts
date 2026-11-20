import type { LocalPromptCatalog } from "./contract.js";

/** 筛选只改变返回数组顺序，不写入配置或触发插件安装。 */
export function exampleLocalPromptCatalog(catalog: LocalPromptCatalog) {
  return catalog.getRecommendedPromptPool(false);
}
