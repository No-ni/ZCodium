# desktop-locale-bootstrap

Main 的启动语言 bootstrap；默认读取 home 下本仓设置，不依赖 renderer 或可变业务根。显式文件覆盖优先，解析失败保持 undefined，异步设置服务继续持有运行时语言。

只登记既有入口；产品规则与验收见 [默认数据根对齐](../../../../../docs/specs/fork-data-root-runtime-alignment.md)。
