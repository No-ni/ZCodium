/**
 * 改编自 zai-org/ZCode aac4755666d09fdcd70272fcf063c077a639015f（Apache-2.0）。
 * Bug 根因：hidden 时 Chromium 不出动画帧，未结算的 CSS 动画会通过 DocumentTimeline
 * 持有已移除的元素及消息子树。以 visibilityState 为唯一来源，禁用 hidden 期间的动画，
 * 避免流式更新创建新的动画引用。规则见 .agents/specs/hidden-document-motion-pause.md。
 */
export const DOCUMENT_HIDDEN_ATTRIBUTE = "data-document-hidden";

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
