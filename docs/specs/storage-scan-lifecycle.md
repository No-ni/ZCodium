# 存储页扫描生命周期

## 产品规则与所有者

- Main 的 StorageService 继续拥有实际扫描任务；useStorageUsage 只拥有当前页面订阅与请求代际。
- 切走、卸载、失焦取消或新扫描取代旧扫描时，旧请求立即失效。旧 startScan 回应迟到后，必须按返回 jobId 取消，不能覆盖新页面的状态。
- 清理后的重新扫描仅在原页面代际仍有效时启动；清理操作本身按已有服务语义完成。
- 保留已知 jobId 的进度过滤与现有 60 秒失焦取消规则，不用延时解决请求顺序。

## 事件顺序

```mermaid
sequenceDiagram
    participant U as 存储页 Hook
    participant M as Main/StorageService（扫描所有者）
    U->>M: startScan
    U->>U: 离开页面，使请求代际失效
    M-->>U: jobId（迟到）
    U->>M: cancelScan(jobId)
    Note over U: 不再设置扫描中或替换新任务
```

## 验收

浏览器交互场景使用真实 React Hook 和可控 preload bridge：进入后立即离开、离开后重新进入且回应乱序、卸载、迟到失败，以及清理完成前离开。断言失效任务被取消、新任务可接收进度、离开后不再启动扫描。该场景验证界面和 bridge 契约，不替代完整 Electron Worker 集成。

### 浏览器断言的同步边界

- `cancelScan` 被 bridge 记录，仅证明取消请求已到达；不代表 React 已提交 `scanning=false`。
- 离开页面、扫描完成或清理完成后，测试先等待页面实际显示 `false`，再断言结果；等待以
  DOM 条件为准，最多 3 秒。持续错误仍会失败，不使用固定 sleep、整例重试或修改产品超时。
- 保留失效 jobId 取消、新任务快照归属、旧回应不能改变新扫描状态，以及清理后不重启的断言。
- 该修正仅调整回归测试；Main 扫描所有者、Hook 状态和 60 秒失焦规则不变。

```mermaid
sequenceDiagram
    participant T as 浏览器测试
    participant H as useStorageUsage
    participant B as 测试 bridge
    participant R as React 页面
    T->>H: 切走页面，释放迟到的启动回应
    H->>B: cancelScan(jobId)
    T->>B: 校验失效 jobId 已取消
    H-->>R: 提交 scanning=false
    T->>R: 等待 DOM 显示 false 后断言
```

## 验证结果

- Windows Chrome 实际执行 `scripts/ci/storage-scan-lifecycle-smoke.mjs`，上述场景及等待启动期间失焦取消、扫描结束后的焦点切换均通过。
- 修复前“离开后迟到回应应取消”场景失败；修复后通过。60 秒规则使用浏览器虚拟时钟验证，没有缩短产品超时。
- 场景已接入 Desktop CI 的浏览器安装之后；本次没有打包或启动完整 Electron 安装版。
- 2026-10-08 补充断言同步后：固定 Node 24.14.0，完整场景在普通 Chrome 与 6 倍 CPU
  降速下均通过；临时注入“页面持续显示扫描中”的错误时，测试在 3 秒内按预期失败。
  临时负例不改动产品 Hook，也不进入仓库。
- 本次 typecheck 通过；Lint 为 0 错误、50 个既有警告；架构检查为 0 违规。改动仅包含
  浏览器回归脚本及本规范；GitHub 结果以推送后的运行记录为准。
