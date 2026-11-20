/** 插件发现材料由原 cache 持有，原 atomic-directory 保留 reservation/target Map 和事务提交入口；事实解析不持有事务副本。 */
export type Entry1 = typeof import("./../plugin-material-cache.js");
export type Entry2 = typeof import("./../atomic-transaction-facts.js");
