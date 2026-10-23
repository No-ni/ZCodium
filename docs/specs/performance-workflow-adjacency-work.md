# 性能扫描：工作流调度图的私有邻接表追加

## 问题与边界

`deriveWorkflowSchedulerState` 每条边都通过 `[...旧数组, 新元素]` 重建 incoming/outgoing 邻接数组。高出度或高入度节点的同一数组反复复制；N 条星形边仅前缀复制就有 N(N-1)/2 个引用。scheduler 的 frontier、ready、blocked 查询会反复调用此纯派生函数。

目标为 zcode-cli legacy 模块 contracts 的纯投影文件，开工时 clean；已读取模块架构上下文、workflow schema/投影实现、scheduler 调用和 package.json 的实际 node:test 测试命令。既有工作流 edge validation 优化不属于本次改动。

## 设计与不变量

- 图事实由现有 workflow runtime snapshot 所有者提供，incomingById/outgoingById 仍只是单次调用内的私有派生 Map；不引入状态、跨调用缓存、协议或新依赖。
- 节点初始化仍复制 dependsOn；重复 node ID 的 Map 仍由最后一个节点初始化覆盖。边循环只对本次私有数组 push，缺失端点时仍建立相应数组。
- dependsOn 前缀、边插入顺序、重复边、缺失节点依赖、self edge 和最终 Set 的首次去重顺序均保留。节点对象引用和输入数组不修改。
- blocked、ready、终态 dependency、collection 状态、active activity、dispatch/admission、owner/lease、Desktop continuous/mobile replayable 均不改变。

## 验收

先保存仅测试使用的原投影参考，补测试并在旧生产实现运行；正确性通过但工作预算失败后才修复。

- 固定种子生成混合节点状态、重复 ID、依赖、重复边、缺失端点和 collection，逐项比较整个 state，冻结输入验证不变。
- 明确验证 dependsOn 与 edge 去重顺序、重复 ID 的最后初始化语义及各终态不阻塞。
- 计数 800 条星形边的字符串数组迭代量，证实旧算法重复访问前缀；新算法按线性预算通过。计数只表示合成工作量，不换算应用整体 CPU/延迟。
- 执行 contracts 实际 test/typecheck 与相关 workflow scheduler 回归；根 typecheck/lint、架构及格式检查。不启动模型或真实 Agent。

## 结果

- 修改前 contracts 包 26 项中 25 通过，唯一失败为本轮工作预算：800 条星形边累计字符串迭代 321,200 次。修改后 26/26 通过，旧/新对照实测 321,200 / 1,600 次。
- 180 份冻结混合图完整 state 与旧算法相等，重复节点、依赖/边顺序、缺失端点和终态规则通过。contracts 与 core 包独立 typecheck 通过。
- 联合 frontier 和既有图扩展回归 18 项通过、1 项显式 benchmark 跳过（没有假称 benchmark 执行）。最终门禁详见 `performance-scan-verified-improvements.md`。
