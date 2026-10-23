# 性能扫描：工作流 collection frontier 单次节点扫描

## 问题与方案

`collectionFrontier` 对 collection 的每个成员使用 nodeById（Array.find）从图头查找。N 个图节点、M 个成员产生 O(M\*N) 次 id 访问。现有调用属于 scheduler 的纯 frontier 计算；graph.ts 开工时 clean，已读取 zcode-cli 架构上下文、workflow schema、graph helpers 和实际测试命令。

- 继续使用 collectionNodeIdsForGraph 的显式成员与 node.collectionId 合并规则，以 Set 表示本次待检查成员。
- 单次按 graph.nodes 原顺序遍历，命中成员后从待检查 Set 删除，只统计首个同 id 节点的 pending / active。原 nodeById 的首次重复 ID 语义不能变成 Map 默认最后一个节点。
- 缺失成员不计数；重复成员只计一次；非成员不访问 status。输入图/collection 不修改。
- 单次纯函数局部 Set，不增加共享缓存、状态所有者、schema、依赖或时序；ready/blocked/dispatch、owner/lease 和两个 delivery profile 不变。

## 验收

旧实现先运行明确语义和固定种子差分测试，工作量断言失败后再改。覆盖显式/隐式成员、重复节点/成员、缺失节点、全部六种 status、空集合；冻结输入验证不变。800 节点全成员图计数 id getter 旧 320,400 次，新 800 次。执行该文件与已有 graph expansion 回归、根 typecheck/lint、架构和格式检查。此为纯计算无交互改动，不启动 Agent/模型。

## 结果

- 原实现 3 项中语义与差分 2 通过，工作预算 1 失败：800 节点 ID 访问 320,400 次。修复后 3/3 通过，访问降为 800 次。
- 220 份固定种子冻结图新旧计数一致，保持重复 ID 的首次状态、缺失节点、显式/隐式成员和空集合语义。
- 联合工作流邻接表和既有图扩展回归 18 项通过、1 项 benchmark 明确跳过；core 独立 typecheck 通过。最终根检查和限制见 `performance-scan-verified-improvements.md`。
