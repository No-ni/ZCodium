# cli-plugin-material-support

插件发现材料由原 cache 持有，原 atomic-directory 保留 reservation/target Map 和事务提交入口；事实解析不持有事务副本。

标准入口快速探测包括本仓 `.zcodium-plugin` 及第三方兼容入口；目录新增使同一次读取失效，不能发布过期材料。

验收与合并范围见 [合并规范](../../../../../../../docs/specs/official-3.18.2-integration.md)。
