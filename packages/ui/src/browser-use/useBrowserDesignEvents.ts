import { useCallback, useRef, type Dispatch, type SetStateAction, type RefObject } from "react";
import type {
  DesignSelectedElement,
  DesignRuntimeCommand,
  DesignInteractionMode,
  DesignPageInfo,
  DesignPageSignals,
  DesignRuntimeEvent,
} from "@zcode/design-runtime";
import { toDesignPageKey } from "./browserDesignProperties.js";
import { selectorOf } from "./browserDesignModeHelpers.js";
type Options = {
  applySelections: (items: readonly DesignSelectedElement[]) => void;
  detachChips: () => void;
  resetChipQueue: () => void;
  runLatest: (command: DesignRuntimeCommand) => Promise<unknown>;
  setSlide: Dispatch<SetStateAction<{ index: number; count: number }>>;
  setModeState: Dispatch<SetStateAction<DesignInteractionMode>>;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  setPageInfo: Dispatch<SetStateAction<DesignPageInfo | null>>;
  latest: RefObject<{
    mode: DesignInteractionMode;
    selections: readonly DesignSelectedElement[];
    variablePreview: Record<string, string>;
    variant: string | null;
  }>;
  runRef: RefObject<((command: DesignRuntimeCommand) => Promise<unknown>) | null>;
  setVariablePreviewState: Dispatch<SetStateAction<Record<string, string>>>;
  setVariantState: Dispatch<SetStateAction<string | null>>;
  setSelections: Dispatch<SetStateAction<readonly DesignSelectedElement[]>>;
  setWritable: Dispatch<SetStateAction<boolean | null>>;
  setTextWritable: Dispatch<SetStateAction<boolean>>;
  setSourceUnreadable: Dispatch<SetStateAction<boolean>>;
  setSignals: Dispatch<SetStateAction<{ pageKey: string; signals: DesignPageSignals } | null>>;
};
export function useBrowserDesignEvents({
  applySelections,
  detachChips,
  runLatest,
  setSlide,
  setModeState,
  setPanelOpen,
  setPageInfo,
  resetChipQueue,
  latest,
  runRef,
  setVariablePreviewState,
  setVariantState,
  setSelections,
  setWritable,
  setTextWritable,
  setSourceUnreadable,
  setSignals,
}: Options) {
  const handleEvent = useCallback(
    (event: DesignRuntimeEvent) => {
      switch (event.type) {
        case "selection-changed":
          applySelections(event.selections);
          return;
        case "slide-changed":
          setSlide({ index: event.index, count: event.count });
          return;
        case "mode-changed":
          // 页面里按 Esc 退出点选
          if (event.mode === "off") {
            setModeState("off");
            setPanelOpen(false);
            void runLatest({ type: "set-selection", selectors: [] });
            detachChips();
          }
          return;
        case "stage-changed":
          // resize 后舞台判断变了：宿主的外框与 webview 底色跟着页面走（!3450 CR-02）
          setPageInfo((info) => (info ? { ...info, stageBackdrop: event.stageBackdrop } : info));
          return;
      }
    },
    [applySelections, detachChips, runLatest],
  );

  const lastInstalledKeyRef = useRef<string | null>(null);
  const handleInstalled = useCallback(
    (info: DesignPageInfo) => {
      setPageInfo(info);
      setSlide({ index: info.currentSlide, count: info.slideCount });
      const run = runRef.current;
      const state = latest.current;
      const infoKey = toDesignPageKey(info.pageUrl);
      const switchedPage =
        lastInstalledKeyRef.current !== null && lastInstalledKeyRef.current !== infoKey;
      const samePage = lastInstalledKeyRef.current === infoKey;
      // 新文档：之前排队的对账（可能卡在旧文档的命令上）全部作废
      resetChipQueue();
      lastInstalledKeyRef.current = infoKey;
      // 刷新后源码就是事实：之前的变量预览值要么已经写进源码，要么被别人改掉了，都不再盖在页面上
      latest.current.variablePreview = {};
      setVariablePreviewState({});
      // 换到另一个页面：退出点选、收起面板、方案复位，和进新页面时一样从头开始（!3548 CR-01）
      if (switchedPage) {
        latest.current.mode = "off";
        latest.current.variant = null;
        setModeState("off");
        setPanelOpen(false);
        setVariantState(null);
      }
      // 换了页面：宿主侧的选中一起清掉，免得之后刷新这个新页面时把旧页面的选择器推回去（!3548 第二轮 CR-01）
      // 兜底：换页时不管还有没有选中都解绑引用、复位一次性提示。正常路径到不了这里——退出点选的各条路径
      // （setMode、mode-changed、运行时卸下、pageKey 换页）都已先调 detachChips；这里只防将来改动漏掉（!3548 第七轮）
      if (!samePage) detachChips();
      if (!samePage && state.selections.length > 0) {
        latest.current.selections = [];
        setSelections([]);
        setWritable(null);
        setTextWritable(false);
        setSourceUnreadable(false);
      }
      if (!run) return;
      void run({ type: "set-mode", mode: state.mode });
      if (state.variant !== null) void run({ type: "set-variant", variant: state.variant });
      // 同一页面刷新（如 Agent 改了文件）后按选择器恢复选中；换了页面就清空
      // （运行时同版本复用时页面里可能还留着宿主已不认识的选中，比如浏览器视图重挂后，这里一并清掉）
      if (samePage && state.selections.length > 0) {
        void run({ type: "set-selection", selectors: state.selections.map(selectorOf) });
      } else {
        void run({ type: "set-selection", selectors: [] });
      }
    },
    [detachChips, resetChipQueue],
  );

  const handleSignals = useCallback((next: DesignPageSignals, url: string) => {
    setSignals({ pageKey: toDesignPageKey(url), signals: next });
  }, []);

  return { handleEvent, handleInstalled, handleSignals, lastInstalledKeyRef };
}
