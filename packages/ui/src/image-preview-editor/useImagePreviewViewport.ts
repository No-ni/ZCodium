import { useEffect, type RefObject } from "react";
import type { Size } from "./geometry.js";
/** 原预览实例的 observer 生命周期；只更新调用者的 viewport setter。 */
export function useImagePreviewViewport(
  viewportRef: RefObject<HTMLDivElement | null>,
  setViewport: (size: Size) => void,
) {
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() =>
      setViewport({ width: viewport.clientWidth, height: viewport.clientHeight }),
    );
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewportRef, setViewport]);
}
