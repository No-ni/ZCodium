# cli-usage-projection

只派生原 CLI 用量记录需要的网络事件、首 token 时间、错误归因及值读取结果。

- 原 runtime/UsageStore 继续拥有执行与持久化；模块不持有 state/cache/store、不执行 IO。
- 网络事件按原顺序筛选，首 token 保留原 startIndex 和 text/reasoning 判定。
- 数值继续有限、非负、截断；空字符串仍返回 undefined。业务错误归因保持原结构，
  由原 UsageStore 保存，模块不记录日志或对外导出。
- 保留 SDK 原始 guard/枚举身份；不引用 Runtime 或 Repo 的具体实现。
