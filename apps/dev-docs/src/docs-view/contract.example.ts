import { createElement } from "react";
import { App } from "./index.js";
/** 页面挂载拥有状态；仅在获准的文档窗口渲染，不读取业务用户目录。 */
export function renderDeveloperDocsExample() {
  return createElement(App);
}
