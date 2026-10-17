type VisibilityListener = (visible: boolean) => void;

interface VisibilityScope {
  observer: IntersectionObserver;
  listeners: Map<Element, VisibilityListener>;
}

const scopes = new WeakMap<Document, VisibilityScope>();

/** 只读片段共用一个观察器，避免长消息为每个围栏建立独立浏览器资源。 */
export function observeCodeSnippetVisibility(
  element: Element,
  listener: VisibilityListener,
): () => void {
  const document = element.ownerDocument;
  const Observer = document.defaultView?.IntersectionObserver;
  // 无可见性能力时保留原文，不把所有历史片段当作可见并批量启动高亮。
  if (!Observer) return () => {};

  let scope = scopes.get(document);
  if (!scope) {
    const listeners = new Map<Element, VisibilityListener>();
    const observer = new Observer((entries) => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
    });
    scope = { observer, listeners };
    scopes.set(document, scope);
  }
  scope.listeners.set(element, listener);
  scope.observer.observe(element);

  return () => {
    scope.listeners.delete(element);
    scope.observer.unobserve(element);
    if (scope.listeners.size === 0) {
      scope.observer.disconnect();
      scopes.delete(document);
    }
  };
}
