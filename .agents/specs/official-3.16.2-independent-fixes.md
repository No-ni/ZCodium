# 官方 3.16.2 独立修复适配

## 范围与基线

固定来源 `zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab`。实现工作区包含 `18cc72ce` 及开工时全部未提交成果；原工作区不参与上游合并。直接 merge 的只读预检有 987 个冲突，不能用整树 ours 伪装同步；本阶段只交付逐模块适配，不宣称完整 3.16 parity，不修改产品版本、提交、推送或构建。

## 工作流模型准入

- 单一 owner 为进程级 `WorkflowConcurrencyGovernor`；runner 的每次模型尝试持一个 ticket，driver、runner 和 governor 读取同一 `resolveWorkflowModelFailurePolicy`。
- 不可重试的配额、认证、配置和请求错误只结算 ended，不削减 cap、不登记 Retry-After 冷却。真正并发限流仍 throttled。
- 一个 ticket 最多结算一次；旧事件、重复 release 无副作用。恢复由用户发起，不能自动续跑手停的 run。
- 保留本仓当前天花板、按 run 轮转、主代理 observer 和冻结模型绑定，不吸收无关的并发策略变化。

```text
模型请求 -> 同一 governor admission -> ticket -> runner
                                             -> 策略表 stop: ended
                                             -> 真限流: throttled
                                             -> 唤醒同桶等待者
```

## 明确空响应

- 只有无文本、无 reasoning、无 tool call 的明确 context finish 转为 `ModelContextExceeded`。转换在成功 finish/状态之前，失败 usage 原样结算。
- stream 与 generate 使用同一纯分类函数；raw finish 优先取直接字段，再取 metadata。拒绝和内容过滤不走 generic empty 重试。
- 有 partial 不重新解释，保留 Core 的续写和 compact 策略。未知空结果仍沿现有一次重试预算。
- 不引入官方 response/body logger，诊断仅保留安全结构和数值。

## Bash 输出

- Node execution adapter 是文件和子进程的单一 owner。优先在操作系统临时目录建立 adapter 私有根；本仓前缀为 `zcodium-bash-`。
- 仅明确的文件系统不可用错误回退已有 `.zcodium` output root，其他故障正常失败。
- 文件准备完成后发布实际路径，再建立后台记录和启动进程。取消/close 覆盖异步准备；准备期间登记 active execution，close 必须等待收尾。
- 前台、后台、workflow child/facade 沿同一接口；输出不随 adapter close 删除，后台 TaskOutput 仍可读取。

## 卡片与未读提示

- Radix Collapsible 补丁仅在 `hidden` 时跳过尺寸测量，保留本仓 transition-none 与淡入行为。
- Renderer 的现有未读任务投影仍是 owner；Main 只收窗口投影并更新原生提示。Windows overlay 与 tray 使用同一去重计数，0 清除，窗口销毁后重算。macOS 保持现有行为。

## 验收

先写回归并在未修改实现上运行，记录失败，再实现。覆盖 stop+长 Retry-After 后恢复可准入、真限流仍降 cap、ticket 幂等；stream/generate context、refusal/filter、partial 和失败 usage；tmp 成功/拒绝/准备中 cancel/close、后台路径；hidden 不测量、展开正常；Windows 计数和清除。

固定工具链：mise Node 24.14.0、pnpm 10.33.2。当前机 Node 为 24.18.0，检查结果明确标注，不冒充固定小版本验收。
