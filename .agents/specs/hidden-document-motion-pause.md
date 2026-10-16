# 页面不可见时停止 CSS 动画

## 产品规则与来源

吸收 zai-org/ZCode `aac4755666d09fdcd70272fcf063c077a639015f` 的
`documentHiddenMotionPause.ts` 与共享 CSS 修复（Apache-2.0），接入本 fork 的实际入口。
上游验证显示 Chromium 在 hidden 时可能通过未结算的 CSS 动画强引用已移除的消息子树；
关闭 hidden 期间的 CSS transition / animation，避免持续流式输出叠加这类引用。
上游内存数字只是问题依据，不作为本 fork 已复现的性能结论。

- 桌面 renderer、普通 Web、手机 `/remote` 的独立入口都在 React `createRoot` 前安装。
- hidden 时关闭元素及 `::before` / `::after` 的 CSS transition / animation；visible 时移除规则标记，后续变化照常过渡。
- 页面隐藏只改变视觉动画，不暂停任务、消息同步、远控重放或业务状态更新。
- 保留 ZCodium 身份、`.zcodium`、自有更新源和 Windows/macOS 桌面边界。

## 状态所有者、契约与事件顺序

`document.visibilityState` 是唯一所有者。共享 UI helper 只写当前文档根节点的
`data-document-hidden` 派生标记，通过公开包子入口
`@zcode/ui/document-hidden-motion-pause` 提供安装函数与清理函数，避免手机入口装载整个 UI barrel。
不创建 Zustand 状态、平台接口、定时器或 Host 事件；三个目标模块均为已有 legacy 模块。

```text
页面入口 → install(document) → 按当前 visibilityState 立即同步 html 标记
                           └→ visibilitychange → 同步标记 → CSS 取消/阻止动画
HMR dispose → 移除本次监听与标记 → 新入口重新安装
```

每个入口只安装一次，每个文档独立，重复 visibilitychange 同步幂等。
页面销毁由浏览器回收监听；热更新使用返回的 dispose 明确清理。
desktop-continuous 与 web-remote-replayable 仍走各自原链路；本标记不承载 owner/lease、序列或恢复事实。

## 失败与迁移边界

- 只覆盖 CSS 动画；不暂停 JavaScript / Web Animations API、rAF 或业务计时器。
- 取消进行中的过渡可能触发 `transitioncancel`，不能依赖它补发 `transitionend`。
  当前 `useAnimatedResizablePanel` 的结束逻辑已有 240ms 清理兜底；其他事件等待口径不改。
- 启动时不存在 React 容器仍沿用原有失败语义；不读写持久化数据，不迁移配置。

## 验收

1. visible / hidden 启动均立即得到正确标记；重复事件不改变事实，恢复可见清理标记。
2. dispose 移除监听和标记，此后事件不再写入；两个文档的可见性互不影响。
3. CI 检查公开子入口及三个实际 bootstrap 在 `createRoot` 前安装，并保留 HMR 清理。
4. 真实 Chromium 页面安装当前 helper 和当前 CSS 规则，启动普通及伪元素动画；切到另一任务页触发真实 hidden，确认动画和过渡均为 none、动画对象停止；回到原页后规则恢复。
5. hidden 期间改变并移除一批带动画元素，不产生新的 CSS 动画对象；验证不请求模型、不接入用户业务数据，不启动开发服务或构建。
6. 定向 node:test、格式、lint、架构通过；仓库级类型、lint 与 CI 脚本测试由主任务统一执行。

## 本次验证记录（2026-10-15）

- `scripts/ci/hidden-document-motion-pause.test.mjs` 的 3 个入口检查通过，其中独立子进程实际执行了 3 个 helper 行为测试。
- 当前 helper 与当前 CSS 规则在 ego-browser 的 Chromium 中验证：页面原生 `visibilitychange` 进入 hidden 后，元素和两种伪元素的动画、过渡均为 `none`，动画对象为 0；事件内修改并移除 200 个元素后仍为 0。恢复 visible 后标记消失，原有 3 个动画恢复。
- 页面内记录原生事件发生时的状态，避免浏览器工具读取页面时自动激活该页而干扰验证。
- 定向格式、lint、架构通过。未运行整机内存压测，也未以本地构建或真实 Agent 会话验证本项；不将上游内存降幅作为本 fork 的实测收益。

## 本轮复验（2026-10-16）

- 当前真实时间线组件和共享 CSS 在 ego-browser 中收到原生 hidden 后：标记存在、动画为 none、动画对象 0；隐藏事件内创建并移除 200 个动画元素后仍为 0。
- 回到 visible 后标记移除，pulse 与时间线动画恢复（本次页面 5 个）；业务订阅没有暂停入口。
- 三入口/CSS 的 CI 门禁及独立 helper 行为测试复跑通过；测试页面、服务和临时资源随主任务收尾。
