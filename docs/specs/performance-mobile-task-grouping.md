# 性能扫描：手机首页任务分组单次分桶

## 问题与设计

MobileApp 的 groupedWorkspaces memo 先稳定排序任务，然后对每个 workspace 全量 filter 一遍任务。W 个 workspace、T 个 task 需 W\*T 次精确 key 比较。只读 UI 派生不需要重复遍历。

- bootstrap 仍为现有连接客户端提供的事实，分组只是当次 memo 的纯派生；不增加 store、缓存、监听器、请求或同步路径。
- 抽取原 memo 算法到同目录 taskGrouping.ts，再以单次 Map 分桶替换 filter；MobileApp 唯一调用该路径，memo 依赖不变。
- 保留 created/updated 的缺省 0、降序稳定 sort、timeline 全任务、workspace 原顺序、label 的 nullish fallback、空组、精确 workspaceKey 相等及未知工作区任务不展示。
- 重复 workspace key 仍产生各自独立的数组，任务对象引用仍原样保留；输入数组不修改。
- 不更改手机卡片、折叠、排序按钮、会话导航、发送门禁、bootstrap/reconnect、owner/lease 或 replayable 链路。无新跨包边，仅使用已有 shared 类型公开入口。

## 验收

先迁移原算法并添加等价/工作量测试。冻结输入、新旧输出对照，覆盖同时间戳、缺失时间、重复/未知 workspace、空结果和切换两种组织/排序；旧算法在 48 workspace/1,440 task 计数 69,120 次任务 key 访问，新算法应为 1,440 次。迁移后旧算法工作预算失败，修复后通过。纯数据派生无交互/布局改动，不新增应用 E2E；执行手机现有协议/生命周期回归及根 typecheck/lint、架构、格式检查。

## 结果

- 原算法迁移后本轮 3 项中等价 2 通过、工作预算 1 失败，48 workspace / 1,440 task 的 workspaceKey 访问为 69,120 次。修复后 3/3 通过，访问为 1,440 次。
- 120 份固定种子输入、两种排序/组织组合与旧算法完整值相等，冻结输入、重复 key 独立数组、稳定同时间戳、空 label/空组和未知 workspace 不显示通过。
- 已纳入 106 文件 / 737 项整合回归（包含手机 protocol / lifecycle）。补跑手机历史布局与消息 schema 4/4 通过。这些不是实际手机 GUI E2E；最终门禁见 `performance-scan-verified-improvements.md`。
