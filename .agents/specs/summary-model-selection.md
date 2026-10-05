# 总结模型与后台流式结果

## 产品与所有权

- `AppSettings.summaryModelSelection` 由 Host 设置服务持久化，是全局偏好的唯一所有者；`null` 和字段缺省都表示跟随会话模型。
- 每次记忆提取、会话标题或目标标题任务调度时，通过既有 runtime preferences 反向请求读取最新偏好；Runtime 不缓存。已经调度的任务保留自己的模型和会话快照，下一次任务读取新设置。
- 子会话继承父会话的读取通道；旧记录或非协议宿主可以没有通道。启动偏好、记录和 Runtime 的回调类型均为可选。
- 标题保留既有默认优先级：显式 `titleGeneration.modelSelection`，然后会话当前模型。全局总结模型有效时优先使用它。
- Host 读取失败、偏好缺省或模型已删除时回到上述默认路径；不自动切换到无关 provider。真实模型网络请求失败仍按现有 adapter 重试和取消规则处理，不宣称任意失败都能完成总结。

## 调用与流式边界

```mermaid
sequenceDiagram
    participant UI as 设置界面
    participant Host as 设置服务（唯一所有者）
    participant Runtime as 会话 Runtime
    participant Model as 模型 adapter
    UI->>Host: update(summaryModelSelection)
    Runtime->>Host: 任务调度时 requestRuntimePreferences
    Host-->>Runtime: 最新偏好或缺省
    Runtime->>Runtime: 创建偏好模型；不可用则沿用默认模型
    Runtime->>Model: streamText（辅助任务上下文和取消信号）
    Model-->>Runtime: 增量、工具调用、finish
    Runtime->>Runtime: 完整收集后执行工具或持久化标题
```

- 桌面和手机复用同一 Host 偏好入口；后台总结增量不进入桌面实时流或手机重放流，已有会话事件与标题持久化路径保持原有语义。
- 默认记忆模型必须保留快照的 `project_memory_extract` / `other` 调用上下文；选择其他模型时同步重新投影工具媒体能力。
- 辅助模型请求继续使用既有低推理档位、输出预算、准入和重试预算。
- 收集器保留完整正文、推理块与签名、完整工具调用及最终用量；未收到 `finish`、错误结束或流抛错必须失败，不返回半成品、不执行已收集工具。
- 回退诊断只记录固定原因和操作分类，不记录原始异常消息、用户 provider/model 标识或凭据。
- 设置保存期间禁用选择器；失败显示可重试提示，保留服务端已有值，不产生未处理的 Promise 拒绝。
- 不迁移用户数据，不改变产品身份，不引入新的配置或传输机制。

## 验收

- CLI bootstrap 类型检查覆盖子会话可选回调，macOS arm64 CI 能完成准备与打包。
- 标题的偏好 provider 删除、Host 失败、清除偏好均回退正确；设置改变后同一 Runtime 下次生成使用新模型。
- 默认记忆与偏好记忆请求都保留辅助调用归因，完整流后才执行工具，错误或不完整流不会执行工具。
- 收集器覆盖分块正文、推理签名、多工具循环、错误和自然截断。
- UI 选择与恢复默认走同一设置写入路径，并覆盖持久化及失效模型展示。

UI 验收夹具：`node scripts/ci/summary-model-settings-fixture.mjs`，监听地址由输出给出。浏览器验证选择模型、恢复默认、保存期间禁用、保存拒绝后的提示与重试；`?locale=en-US&theme=dark&mode=deleted` 验证英文、深色及已删除模型展示。夹具仅使用虚构数据，验收后按 Ctrl-C 释放端口。
