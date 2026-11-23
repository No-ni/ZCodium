# ui-style-build

本模块登记现存 UI 颜色构建脚本的归属。公共实现仍是 `packages/ui/lucide-colors.mjs` 的 Tailwind 插件默认导出，构建入口仍为 `styles.css` 的 `@plugin`，没有新的颜色服务或编译入口。

主题 CSS 是颜色及透明度的唯一来源。文本和 Lucide 读取同一组 alpha；插件只按颜色 token 的身份生成继承变量、一次 SVG 合成及原有状态类。亮暗主题、hover、disabled、透明度与嵌套颜色均按既有 CSS 继承关系处理。

插件不访问业务服务、文件、网络、会话或运行时状态。契约类型沿用 Tailwind 的公开插件返回类型，例子只描述该类型的正常配置用法。真实 CSS 编译与浏览器像素回归由 `packages/ui/test/browser/manual-review/pending/lucide-opacity.test.mjs` 验证。
