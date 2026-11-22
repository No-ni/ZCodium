# source-workspace-alias-repo

Source Server 装配层传给官方 workspace alias Repo 的本仓路径。只有路径计算，不执行 IO。迁移仍由原 Repo 持有；显式 Repo 参数优先。冻结 ledger、schema/checksum、owner/lease、无关行和来源配置不因路径适配改变。

只登记既有入口；产品规则与验收见 [默认数据根对齐](../../../../../docs/specs/fork-data-root-runtime-alignment.md)。
