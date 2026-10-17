# 第十一轮：技能同步目录尺寸扫描的单次遍历有界 IO

## 规则与所有者

打开远端技能同步界面时，`RemoteSkillSyncDialog` 会通过已有 `ISkillSyncService` 查询本机技能候选。候选扫描逐个读取 `SKILL.md`，并为每个候选计算整棵技能目录的字节数。当前 `computeRecursiveSize` 对每层目录的全部子项使用 `Promise.all`，宽目录会同时启动 O(N) 个 `lstat`/`stat`/`realpath` 请求；递归层数叠加时，同一候选扫描的在途文件系统请求没有总量上界。

- 单次 `collectUserSkillCandidates` 调用继续拥有临时扫描状态；不建立跨请求缓存或第二份候选事实。
- 候选尺寸计算按既有候选遍历顺序串行执行；每次递归遍历使用一个局部 worker 池，将该整棵目录树的在途元数据 IO 总数限制为 8。不在每个递归节点另开池，也不在递归调用之间持有 worker 槽位等待子树，避免死锁与层数放大。
- 每个文件/目录仍计入原始字节数；符号链接目标按既有 realpath 去重，重复目录只计一次；无效链接计零。遍历完成后候选仍按既有目录名顺序排序。
- 保持目录项原有错误语义：`lstat`/`readdir` 错误仍使该候选尺寸计算失败；符号链接 `stat`/`realpath` 失败沿用既有降级规则。
- `MAX_SKILL_SCAN_DEPTH` 与排除目录只约束技能 Markdown 发现，不扩展成新的尺寸剪枝规则；尺寸仍覆盖候选目录的全部内容。
- 不改变 skill service 接口、归档大小门槛、写入路径、workspace identity、远端 session 路由或 Desktop continuous/mobile replayable 语义。

```mermaid
flowchart LR
    UI[RemoteSkillSyncDialog] --> Service[ISkillSyncService owner]
    Service --> Candidates[单次候选扫描]
    Candidates -->|逐个候选| Tree[候选目录尺寸与软链去重]
    Tree --> Pool[本次遍历有界文件系统 IO worker 池]
    Pool --> Result[原候选顺序与尺寸结果]
```

## 验收

- 先在未改生产代码上运行受控 `lstat` IO 夹具，证明宽目录的峰值并发超过固定预算。
- 修复后验证单个候选的嵌套宽目录总并发不超过预算、多个候选仍按顺序计算；没有预创建与输入规模等长的 Promise 集合。
- 对照朴素尺寸总和验证文件大小、空目录、嵌套目录、重复符号链接、断链及候选排序。
- 受控 `lstat`/`readdir` 异常验证错误传播不变；符号链接 `stat`/`realpath` 异常沿用原来降级结果。
- 执行目标 Vitest、定点 lint/格式和 `architecture:check --changed`；根 `typecheck`/`lint` 由主代理统一运行。不提交、推送或构建。

## 当前证据范围

该界面打开会触发本机候选扫描；每个候选均触发一次整目录尺寸遍历。合成宽目录用于证明总并发上界，不代表典型用户目录大小或实际磁盘耗时收益。

## 实施与验证

- 初始受控宽目录夹具在旧生产代码的峰值 `lstat` 并发为 34，超过 8 的预算。最终夹具扩展为两个候选，各有 520 个直接文件和 520 个嵌套文件，校验候选排序、总字节数与队列压缩。主代理通过临时 Vitest load 插件将该服务加载为开工快照，保持生产文件不变，独立复跑最终工作量测试：旧实现峰值为 522，预算失败；新实现通过 ≤8 的预算。
- 最终目标 Vitest 4/4，覆盖重复/循环目录软链、断链、realpath 失败回退、lstat/readdir 错误，以及出错停派后等在途 IO 排空才拒绝。测试 mock 的目录项与原 `readdir(..., { withFileTypes: true })` 契约一致。
- 定点 lint、格式及架构检查通过。服务代理只读复核本轮 UI selector 的重复 ID 首见/后写规则、输入与 workspace 隔离，未发现可操作问题；主代理复核本服务的扫描级并发、无递归持槽、队列释放与错误排空。

根检查与整体回归由本轮总记录报告。全部文件系统边界由夹具替换，没有读取真实用户技能或导入任何归档。
