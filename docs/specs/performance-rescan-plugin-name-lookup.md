# 插件名称回退的自有键查找修复

## 问题与边界

合法插件 slug 的某一分段为 `constructor` 时，共享名称格式化器的普通对象索引会读到原型链上的构造函数，最终显示函数源码，而不是名称。设置列表、提及面板及 CLI 列表通过现有 `resolvePluginDisplayName` 入口受影响；不涉及插件获取、安装或市场网络行为。

本次仅修复 [共享名称格式化器](../../packages/shared/src/plugin-display-name.ts) 内部缩写查找，不修改 UI、协议、国际化策略或插件身份。共享模块为 legacy、`managed: false`；没有新增公开接口、跨模块依赖、状态、缓存或异步流程。

## 既有契约与修法

- 缩写只允许命中显式配置的 `aws`、`mcp`、`zcode`；原型属性不能作为缩写结果。
- 使用私有 `ReadonlyMap` 与 `get`，避免读取原型链。
- 保留 trim、连字符/下划线分词、空分段过滤、locale 首字符大写及剩余字符的原始大小写。`CONSTRUCTOR` 仍显示 `CONSTRUCTOR`，不强制改成标题大小写。
- listing 显示名仍优先精确语言、语言前缀、基础显示名；仅缺失时回退 slug。显式空显示名仍保留。

## 验收

先在未修复实现上执行正式回归，再做最小修复并执行同一回归：

1. `constructor` 及大小写变体不再显示函数源码。
2. `aws-constructor`、`my_constructor` 等任意分段位置正确。
3. 既有缩写、混合分隔符、普通名称不变。
4. `__proto__` 和 `toString` 等名称保留既有分词/大小写结果。
5. 空白与纯分隔符名称仍返回空串。
6. 土耳其语首字母大写保持 locale 语义。
7. listing 优先级、空显示名与缺失 listing 回退不变。

实际红/绿结果：修复前 7 项源测试中 4 通过、3 失败，失败均为 constructor 名称错误；修复后同一 7 项全部通过。入口为 [隔离回归入口](../../scripts/ci/plugin-display-name-prototype-regression.test.mjs)，强制校验实际执行测试数为 7。

验证使用项目隔离测试入口；所有测试输入均为内存合成数据，无文件、网络或用户配置访问。这是确定性显示 bug 修复，不声称带来性能收益；未执行浏览器/桌面 E2E。
