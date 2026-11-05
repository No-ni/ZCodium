# Host 异步生命周期失败收口

2026-11-04 代码审查修复，补充 [R1 窗口级 Host 规格](../architecture/r1-single-window-host-refactor.md) 的既有生命周期与被动 sessions-index 订阅规则，不新增 owner、接口或投递路径。

## 工作区准备失败

`WindowRemoteConnectionRegistry` 是 logical session 的唯一 owner。workspace inspect / runtime prepare 失败必须经现有 `disposeSession` 释放本次 logical owner，不能直接删行而跳过连接生命周期。

最后一个 owner 失败时，Docker/Server dedicated handle 立即释放，WSL 进入已有 idle TTL 并保留运行任务保护，SSH online handle 继续作为窗口 cache。仍有其他 owner 时不得释放共享连接；失败 scope 不发布 ready 或 attachment。该收口不停止远端 daemon、不改 CLI 会话状态，也不改变桌面 continuous / 手机 replayable 投递语义。

```text
workspace inspect / runtime prepare 失败
  -> Registry disposeSession：撤销 logical scope
       -> 其他 owner 仍在线：保留共享 handle
       -> 最后 owner：Docker/Server dispose；WSL idle TTL；SSH window cache
```

回归入口为 `scripts/ci/remote-registry-workspace-failure.test.mjs`，在项目隔离子进程执行真实 Registry 的 5 个内存生命周期场景。修复前 Server 不释放 handle、WSL 超过 idle TTL 仍保留 handle，两项失败；修复后这两项及 WSL sibling、SSH cache、Docker dedicated 场景通过。

## 订阅换代后的迟到失败

`WindowHostSessionsIndexObserver` 唯一持有该 source 的订阅 generation、subscriptionId、cursor、恢复与 dormant 状态。订阅与 resync 的成功、失败续体都必须确认 observer 未释放且仍属于发起时的 generation / subscriptionId。

旧 runtime 的迟到失败只能结束旧请求，不能拆掉新订阅、把已 available 的 runtime 重新标为 dormant，或在 observer 已释放后报告新错误。当前代际的失败仍沿用 existing-only 恢复与 dormant 等待规则。

```text
旧 resync / subscribe 请求 ── pending
runtime unavailable -> invalidate generation -> available -> 新订阅 snapshot
旧请求失败 -> 校验 generation / subscriptionId -> 已退休，停止续体
```

回归入口 `scripts/ci/sessions-index-observer-retirement.test.mjs` 使用真实 observer、内存 frame/lifecycle emitter 与可控 RPC Promise，执行 5 个场景。修复前换代后的 resync 失败拆掉新订阅、释放后失败报告错误、换代后的 subscribe 失败阻止新订阅，三项失败；修复后全部通过，当前代际的 resync retry 与 unavailable 等待 available 保持原规则。

## 验证边界

两个入口复用 `project-test-sandbox.mjs` 与 `source-test-runner.mjs`，写入仅在当前工作树。没有连接真实远端、操作用户数据、启动 Electron 或建立手机 attachment；内存生命周期证据不替代 Electron、SSH/WSL 与手机真机验收。
