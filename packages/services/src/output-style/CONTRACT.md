# Output style 服务

本模块包装现有输出样式的枚举、文件增删改与激活设置。公开合同复用 `IOutputStyleService`，由既有 services descriptor 提供服务访问，构造入口从 `index.ts` 导出。

- 原服务是样式文件与激活设置的唯一读写方；消费者不复制持久化状态。读取方法按当前文件和设置快照返回，不发布广播事件。
- 内建 Default、Explanatory、Learning 样式及其 ID 保持。自定义样式继续沿用当前文件命名、`custom-` ID 和激活投影规则。
- 写入方法等待既有文件 IO；删除沿用 force 幂等语义。接口不新增锁、重试、事务或更强的失败保证。
- 现有 Claude 配置兼容目录由服务按环境 HOME/USERPROFILE 解析，与应用的 `.zcodium` 数据根分开。测试不得访问真实用户配置，只能注入项目内沙箱环境。
- 自定义名称和更新/删除 ID 只能映射到 output-styles 的直接子文件；拒绝斜杠、反斜杠、NUL 与当前平台的非法文件名，不允许把名称解释为路径。既有无前缀 ID、Unicode、空格和文件名中间的 `.md` 仍可使用；列表只移除末尾 `.md`，确保列出的 ID 可以更新、删除同一文件。

依赖限于 shared 的样式类型与服务通道、services 的 descriptor。模块登记只收口维护边界，不接入官方账号、云配置或遥测，也不改变现有产品行为。
