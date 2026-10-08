/**
 * 桌面启动视觉层的唯一退出路径；不存在遮罩的 Web/手机入口自然为空操作。
 * 业务加载从不等待动画，重复 ready、异常抢占与动画取消都不能留下遮罩。
 */
export function finishStartupPresentation(immediate = false): void {
  if (typeof document === "undefined") return;
  const overlay = document.getElementById("zcodium-startup-overlay");
  if (!overlay) return;

  if (immediate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    overlay.remove();
    return;
  }
  if (overlay.dataset.exiting === "true") return;
  overlay.dataset.exiting = "true";
  const exit = overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 160,
    easing: "ease-out",
    fill: "forwards",
  });
  // animation.finished 在动画取消时会 reject；两条路径都必须释放视觉层，不能靠超时猜就绪。
  void exit.finished.then(
    () => overlay.remove(),
    () => overlay.remove(),
  );
}
