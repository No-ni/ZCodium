# 第八轮：进程快照遍历不依赖调用栈

## 原因、边界与决定

资源采样的进程归属已在第五轮使用显式 DFS，但同步和异步进程快照仍分别使用递归 DFS。足够深的后代链会抛出 `RangeError`，使 cleanup 无法得到完整身份快照。20,000 层是合成鲁棒性上限，用来证明工作量与输入规模线性，不代表常见桌面进程形态或日常延迟收益。

- 模块为 `services`。Host/runtime lifecycle 仍唯一拥有受管 child、生命周期时间和 cleanup；进程表读取、身份校验、deadline、强制终止路径均保持原状。
- 同步和异步 snapshot 使用同模块内部的单一纯遍历函数；临时 children map、seen 集合和 DFS 栈只属于本次调用，不建立跨请求缓存或第二份事实。
- 使用显式 DFS 帧保存每个父节点的下一子节点位置，保持原进程表插入顺序、深度优先输出与首次遇到 PID 时去重。根 PID 预先标记，循环、重复 PID、缺失父节点和脱离子树的节点保留原语义；返回原 identity 引用，不修改输入。
- 保留同步 POSIX owned PGID 合并、Linux 身份 refine 和 Windows 创建时间检查；异步 Windows root 查询中退出、PID 复用、生命周期候选过滤及同步 fallback 均保持原语义。同步与异步既有的生命周期上界差异不在本次更改。
- 不改公共接口、owner/lease、业务状态、持久化、远端 identity 或 Desktop continuous/mobile replayable 边界；这里是 Host 本地进程生命周期辅助计算。

```mermaid
flowchart LR
    Lifecycle[Host runtime lifecycle owner] --> Query[既有进程表读取]
    Query --> Identity[既有 root / 创建时间 / PGID 归属校验]
    Identity --> DFS[单次纯 DFS 显式帧遍历]
    DFS --> Snapshot[保序身份快照]
    Snapshot --> Cleanup[既有身份复核与 cleanup]
```

## 验收

- 先补回归，分别经同步与异步公开 snapshot 入口驱动 20,000 层活 root 和退出 root 后代链，旧实现抛 `RangeError`；修复后身份和 PID 全量、顺序正确。
- 小图对照原递归算法，包括乱序分支、环、重复 PID、缺失 root、脱离子树；输入冻结，输出引用保持。
- 异步 root 查询中退出不能认领复用 root；退出 root 的生命周期过滤保留严格上界，不纳入之后创建的新后代。
- 根目录固定 Node 24.14.0 下运行目标 Vitest、定点 lint、格式和 architecture 检查；父任务统一运行完整 typecheck/lint。不提交、推送或构建。

## 实施与验证

- 原实现首跑 7 项：4 个 20,000 层链场景均抛 `RangeError`，3 个行为对照通过；修复后新增 POSIX PGID 和创建时间边界场景，新回归 9/9，通过第五轮既有进程采样 10/10，合计 19/19。
- 101 个固定或确定性生成的小图与原递归 DFS 逐项对照。同步保留既有 PID Map 合并顺序，异步保持原 identity 引用；覆盖重复 PID、循环、缺失 root、脱离子树、root 在异步查询期间退出及复用 PID 的创建时间过滤。同步和异步原有上界语义分别校验。
- 两个快照入口改用同一私有模块 helper，定点 lint 0 warning/error；架构 baseline 0/new 0。原有进程表 I/O、缓存、deadline、所有权及终止逻辑均未改写。
- 回归通过受控进程表驱动真实公开快照函数，未启动 20,000 个系统进程或完整 Electron/Agent cleanup；该计量证明合成深链可完整处理，不代表实际日常 CPU 或延迟收益。
