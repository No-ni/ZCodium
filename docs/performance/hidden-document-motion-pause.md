# 页面不可见时暂停 CSS 动画

## 问题

窗口不可见（最小化、切到其他桌面、锁屏熄屏、手机浏览器切后台）时，Chromium 不再产出动画帧，
`DocumentTimeline` 上的 CSS transition / animation 无法结算。此时若带动画的元素被移除
（虚拟列表回收、切 task、流式重挂），`HTMLDocument → DocumentTimeline → CSSTransition`
仍强引用该元素，并经 parent 指针拖住整棵已卸载的消息子树，直到页面重新可见才释放。

实测（2026-09-29，隔离 HOME + mock provider 流式压测，GC 后）：

| 状态               | DOM 节点 | JS 监听器 | renderer footprint |
| ------------------ | -------- | --------- | ------------------ |
| hidden 期间        | 235,382  | 12,071    | 498 MB             |
| 恢复 visible 1s 后 | 45,297   | 1,943     | 379 MB             |

受控实验：hidden 下触发 transition 再移除 → 100% 留存（先 `cancel()` 也留存）；
不触发 transition → 0 留存。主要入口是 markdown 表格随测量变化的
`transition-[max-width]` / `transition-[width,opacity]`，但机制对所有 CSS 动画成立。

## 约定

```
visibilitychange ──► document.visibilityState === "hidden"
                        │ 是                         │ 否
                        ▼                            ▼
          <html data-document-hidden>        移除 data-document-hidden
                        │
                        ▼
   *:not([data-motion-persistent], [data-motion-persistent] *), ::before, ::after
     { transition: none; animation: none }（!important）
   → hidden 期间不会创建新的 CSSTransition / CSSAnimation，被移除元素可正常 GC
```

- 唯一数据源是 `document.visibilityState`；安装时立即同步一次，之后只响应 `visibilitychange`，不引入定时器。
- 桌面 renderer 与 Web（含手机 `/remote`）入口在 `createRoot` 前各调用一次
  `installDocumentHiddenMotionPause()`（`packages/ui/src/lib/documentHiddenMotionPause.ts`）。
- 页面不可见时用户看不到画面，关闭动画无可见影响；transition 在恢复可见后直接落到终态，后续变化照常过渡。
- **常驻动画子树豁免（`data-motion-persistent`）**：恢复可见时撤销 `animation: none` 会让浏览器
  重新创建 `animation-name` 对应的动画对象并从 0 播放——只有 transition 会跳到终态，animation 不会。
  侧栏折叠（`animate-collapsible-down`、`animate-in fade-in-0`）就是常驻挂载的进入动画：Radix
  Collapsible 打开后元素不重建，于是每次切后台再回前台都把展开动画重播一遍（历史 bug：表现为切回窗口时
  左侧项目列表像被清空重载）。因此侧栏根节点 `packages/ui/src/project-sidebar/index.tsx` 的
  `<aside data-testid={TID_SIDEBAR} data-motion-persistent="">` 及其整棵子树不参与暂停；
  消息流等高频 churn 子树保持原行为，GC 收益不变。新增常驻动画容器时用同一常量
  `DOCUMENT_MOTION_PERSISTENT_ATTRIBUTE` 打标，不要放宽选择器。
- 附带收益：Radix Presence 等“等 `animationend` 才卸载”的退出动画在 hidden 下读到 `animation-name: none`，
  会同步卸载，不再滞留遮罩。

## 验证结果

同一压测脚本、窗口最小化（hidden）下连续 15 轮，GC 后对比：

| 指标                          | 修复前  | 修复后 |
| ----------------------------- | ------- | ------ |
| DOM 节点（Memory counters）   | 175,224 | 22,361 |
| JS 监听器                     | 12,071  | 1,213  |
| heap snapshot detached 节点   | 109,407 | 3,819  |
| 受控实验留存（20,050 个节点） | 100%    | ~2%    |

剩余 detached 由 TanStack virtual `elementsCache` 经挂起的 rAF 闭包持有，恢复可见后结算，有界。

## 边界

- 只覆盖 CSS transition / animation；`motion` 等 JS 驱动（Web Animations API）的动画不受影响。
- `data-motion-persistent` 子树在 hidden 期间不暂停，其常驻动画对象不在「hidden 期间不创建」的豁免结论范围内；
  只给屏幕上数量有界、动画对象固定的容器打标，不要给消息流等随数据增长的子树打标。
- 进入 hidden 瞬间正在进行的过渡会被取消（触发 `transitioncancel` 而非 `transitionend`），
  依赖 `transitionend` 收口的逻辑需自带兜底（现有 `useAnimatedResizablePanel`、
  `HighspeedActivationVisual` 已有超时兜底）。
