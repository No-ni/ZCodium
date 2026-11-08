/**
 * 页面不可见时暂停 CSS 动画，spec 见 docs/performance/hidden-document-motion-pause.md。
 *
 * Bug 根因：窗口 hidden 时 Chromium 不出动画帧，CSS transition/animation 无法结算；
 * 带动画的元素此时被移除，DocumentTimeline 仍强引用它，并经 parent 指针拖住整棵已卸载的
 * 消息子树（实测 hidden 期间 GC 后 23 万 DOM 节点，恢复可见 1s 内回落到 4.5 万）。
 * 这里以 document.visibilityState 为唯一数据源给 <html> 打标记，styles.css 据此禁用动画，
 * 保证 hidden 期间不创建新的动画对象。
 */
export const DOCUMENT_HIDDEN_ATTRIBUTE = "data-document-hidden";

/**
 * 常驻动画子树标记：带此属性的子树不参与 hidden 动画暂停。
 *
 * Bug 根因：恢复可见时移除 {@link DOCUMENT_HIDDEN_ATTRIBUTE} 会把 `animation: none` 撤掉，
 * 浏览器据此重新创建 `animation-name` 对应的动画对象并从 0 播放——只有 transition 会直接
 * 跳到终态。侧栏的展开动画是常驻挂载的进入动画（Radix Collapsible 打开后不再重建元素），
 * 于是每次切后台再回前台都会重播一次展开动画，用户看到的就是列表像被清空重载。
 * 这类动画不能取消，用本标记排除在暂停范围外；消息流等高 churn 子树仍按 spec 暂停，
 * 保留「hidden 期间不创建动画对象」的 GC 收益。
 */
export const DOCUMENT_MOTION_PERSISTENT_ATTRIBUTE = "data-motion-persistent";

export function installDocumentHiddenMotionPause(doc: Document = document): () => void {
  const sync = () => {
    doc.documentElement.toggleAttribute(
      DOCUMENT_HIDDEN_ATTRIBUTE,
      doc.visibilityState === "hidden",
    );
  };
  sync();
  doc.addEventListener("visibilitychange", sync);
  return () => {
    doc.removeEventListener("visibilitychange", sync);
    doc.documentElement.removeAttribute(DOCUMENT_HIDDEN_ATTRIBUTE);
  };
}
