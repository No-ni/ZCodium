import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { LoadedDoc, AgentPointer } from "#ui/shell/state.ts";
import type { RevealRequest } from "#ui/shell/useDocumentSurface.ts";
import type { ViewerHandle } from "#ui/viewers/types.ts";

/** Agent marks are a local projection, admitted by the current document/handle generation. */
export function useAgentPointer(
  viewer: RefObject<ViewerHandle | null>,
  generation: RefObject<number>,
  canvas: RefObject<HTMLDivElement | null>,
  doc: LoadedDoc | null,
  closeFind: () => void,
) {
  const [agent, setAgent] = useState<AgentPointer | null>(null);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const ticket = useRef(0);
  const pinned = useRef(false);
  const reset = useCallback(() => {
    ++ticket.current;
    pinned.current = false;
    viewer.current?.clearReveal();
    setAgent(null);
  }, [viewer]);
  const reveal = (request: RevealRequest) => {
    const handle = viewer.current;
    if (!handle) return;
    closeFind();
    const mine = ++ticket.current;
    const documentGeneration = generation.current;
    void handle.reveal(request.targets).then(
      (targets) => {
        // 旧文档或已清除标记的异步定位不能在新 surface 上提交结果。
        if (
          mine !== ticket.current ||
          documentGeneration !== generation.current ||
          viewer.current !== handle
        )
          return;
        pinned.current = targets.length > 0;
        setAgent(
          targets.length
            ? {
                note: request.note,
                targets,
                index: 0,
                visible: Boolean(request.note) || targets.length > 1,
              }
            : null,
        );
      },
      () => undefined,
    );
  };
  const onRevealHit = useCallback((index: number) => {
    const current = agentRef.current;
    if (!current?.targets[index] || !(current.note || current.targets.length > 1)) return false;
    setAgent({ ...current, index, visible: true });
    return true;
  }, []);
  const stepAgent = (index?: number) =>
    setAgent((current) => {
      if (!current) return current;
      const next = index ?? (current.index + 1) % current.targets.length;
      current.targets[next]?.scrollTo();
      pinned.current = true;
      return { ...current, index: next, visible: true };
    });
  useEffect(() => {
    const container = canvas.current;
    if (!container) return;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      if (!pinned.current) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const current = agentRef.current;
        if (pinned.current && current) current.targets[current.index]?.scrollTo();
      }, 200);
    });
    observer.observe(container);
    const unpin = () => {
      pinned.current = false;
    };
    const dismiss = (event: PointerEvent) => {
      if ((event.target as Element).closest(".callout, .chip, .pop, .pill")) return;
      setAgent((current) => (current?.visible ? { ...current, visible: false } : current));
    };
    container.addEventListener("wheel", unpin, { passive: true });
    container.addEventListener("pointerdown", unpin, true);
    container.addEventListener("keydown", unpin, true);
    container.addEventListener("pointerdown", dismiss, true);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      container.removeEventListener("wheel", unpin);
      container.removeEventListener("pointerdown", unpin, true);
      container.removeEventListener("keydown", unpin, true);
      container.removeEventListener("pointerdown", dismiss, true);
    };
  }, [canvas, doc]);
  return { agent, setAgent, reset, reveal, onRevealHit, stepAgent };
}
