import { useBrowserDesignEvents } from "./useBrowserDesignEvents.js";
import { useBrowserDesignPlugin } from "./useBrowserDesignPlugin.js";
import { useBrowserDesignChips } from "./useBrowserDesignChips.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildCssVariableTweakControls,
  DESIGN_PAGE_LIMITS,
  formatTweakValue,
  type DesignInteractionMode,
  type DesignPageInfo,
  type DesignPageSignals,
  type DesignRuntimeCommand,
  type DesignSelectedElement,
} from "@zcode/design-runtime";
import {
  DESIGN_STYLE_CSS_NAMES,
  toDesignPageKey,
  type DesignStyleProperty,
} from "@/browser-use/browserDesignProperties.js";
import { useBrowserDesignRuntime } from "@/browser-use/useBrowserDesignRuntime.js";
import { useBrowserDesignSourceWriter } from "@/browser-use/useBrowserDesignSourceWriter.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { shouldAutoShowDesignTools, selectorOf } from "./browserDesignModeHelpers.js";
import { type DesignChipTarget, type BrowserDesignModeInput } from "./browserDesignTarget.js";
export { type DesignChipTarget } from "./browserDesignTarget.js";

export { shouldAutoShowDesignTools } from "./browserDesignModeHelpers.js";

export function useBrowserDesignMode({
  captureElement,
  chipTarget,
  currentUrl,
  fileService,
  onSelectModeStart,
  isVisible,
  probeEnabled,
  remoteSessionId,
  workspaceIdentity,
  webview,
  webviewGeneration,
}: BrowserDesignModeInput) {
  const { intl } = useZCodeIntl();
  const pageKey = toDesignPageKey(currentUrl);
  const { pluginEnabled, requestPluginSelection } = useBrowserDesignPlugin({
    chipTarget,
    remoteSessionId,
    workspaceIdentity,
    probeEnabled,
    isVisible,
    pageKey,
  });
  const [signals, setSignals] = useState<{ pageKey: string; signals: DesignPageSignals } | null>(
    null,
  );
  const [mode, setModeState] = useState<DesignInteractionMode>("off");
  const [panelOpen, setPanelOpen] = useState(false);
  const [pageInfo, setPageInfo] = useState<DesignPageInfo | null>(null);
  const [selections, setSelections] = useState<readonly DesignSelectedElement[]>([]);
  /** 选中的元素都能在源码里找到（能直接写回）；null 表示还在查 */
  const [writable, setWritable] = useState<boolean | null>(null);
  /** 主选中元素的文字能不能在面板里改（源码里只含文字） */
  const [textWritable, setTextWritable] = useState(false);
  /** 源文件读不了（不是 UTF-8、太大、读报错）：面板说明原因，不当成「元素对不上」 */
  const [sourceUnreadable, setSourceUnreadable] = useState(false);
  const [variablePreview, setVariablePreviewState] = useState<Record<string, string>>({});
  const [variant, setVariantState] = useState<string | null>(null);
  const [slide, setSlide] = useState({ index: 0, count: 0 });

  const autoToolsVisible =
    signals?.pageKey === pageKey && shouldAutoShowDesignTools(signals.signals, currentUrl);
  // 设计稿页面（设计产物）才出设计工具行、深色画布、方案和翻页
  const toolsVisible = probeEnabled && pluginEnabled && autoToolsVisible;
  // 人类 tab 的「选择元素」在任何页面上都是这套点选（11-06 统一，取代原来的元素选择器）：
  // 普通网页开着点选时也装运行时，调整面板按页面能不能写回决定可改还是只读
  const runtimeActive = pluginEnabled && (toolsVisible || (probeEnabled && mode !== "off"));

  // 异步回调（注入完成、截图回来、写回完成）读最新值，不依赖闭包里的旧 state
  const latest = useRef({ mode, selections, variablePreview, variant, pageKey, toolsVisible });
  latest.current = { mode, selections, variablePreview, variant, pageKey, toolsVisible };
  const runRef = useRef<((command: DesignRuntimeCommand) => Promise<unknown>) | null>(null);
  const runLatest = useCallback(
    (command: DesignRuntimeCommand) => runRef.current?.(command) ?? Promise.resolve(null),
    [],
  );

  const pushVariables = useCallback(
    (values: Record<string, string>) => {
      latest.current.variablePreview = values;
      setVariablePreviewState(values);
      void runLatest({ type: "set-css-variables", values });
    },
    [runLatest],
  );
  const setVariablePreview = useCallback(
    (name: string, value: string | null) => {
      const next = { ...latest.current.variablePreview };
      if (value === null) delete next[name];
      else next[name] = value;
      pushVariables(next);
    },
    [pushVariables],
  );

  const writer = useBrowserDesignSourceWriter({
    fileService,
    pageKey,
    pageUrl: currentUrl,
    run: runLatest,
    setVariablePreview,
  });
  const { checkWritable } = writer;

  const { reconcileChips, detachChips, resetChipQueue } = useBrowserDesignChips({
    captureElement,
    chipTarget,
    intl,
    latest,
    runLatest,
  });
  // ---- 选中能不能写回：每次选中变了按当前源码查一次，结果对不上当前选中就丢掉 ----
  const checkGenerationRef = useRef(0);
  const checkedKeyRef = useRef("");
  const refreshWritable = useCallback(
    (items: readonly DesignSelectedElement[]) => {
      const generation = ++checkGenerationRef.current;
      if (items.length === 0) {
        checkedKeyRef.current = "";
        setWritable(null);
        setTextWritable(false);
        return;
      }
      // 同一组元素重读（写回、撤销后）时保留上次结果，面板不闪「正在对应源码」
      const key = items.map(selectorOf).join("\n");
      if (key !== checkedKeyRef.current) setWritable(null);
      checkedKeyRef.current = key;
      void checkWritable(items).then(({ elements, readable }) => {
        if (generation !== checkGenerationRef.current) return;
        const all = readable && elements.every((element) => element.located);
        setWritable(all);
        setSourceUnreadable(!readable);
        // 面板里改文字只在单选且源码里该元素只含文字时开（!3450 SG-01）
        setTextWritable(all && elements.length === 1 && elements[0]?.textWritable === true);
      });
    },
    [checkWritable],
  );

  const applySelections = useCallback(
    (items: readonly DesignSelectedElement[]) => {
      latest.current.selections = items;
      setSelections(items);
      // 设计稿页面点中元素就打开属性面板显示它（关过面板也一样，11-05 反馈）；
      // 普通网页点选是为了把元素加进聊天，不自动弹面板挡住页面，要改再点「调整面板」（11-11 用户反馈）
      if (items.length > 0 && latest.current.toolsVisible) setPanelOpen(true);
      refreshWritable(items);
      reconcileChips();
    },
    [reconcileChips, refreshWritable],
  );

  // 写回 / 撤销之后按选择器重新读一遍选中元素：面板显示的是页面上的实际值（唯一来源），不在宿主侧拼
  const rereadSelections = useCallback(() => {
    const selectors = latest.current.selections.map(selectorOf);
    if (selectors.length > 0) void runLatest({ type: "set-selection", selectors });
  }, [runLatest]);
  const {
    commitElements: writeElements,
    commitVariable,
    isOwnWrite,
    undo: undoWrite,
    redo: redoWrite,
  } = writer;
  // 写回失败时页面由 writer 按这次读到的源码撤回（!3450 SG-02、Q-design-rollback-baseline）；
  // 换了页面的过期任务（stale）什么都不动，连重读也不发
  const commitElements = useCallback(
    async (edits: Parameters<typeof writeElements>[0]) => {
      const result = await writeElements(edits);
      if (result !== "stale") rereadSelections();
      return result;
    },
    [rereadSelections, writeElements],
  );
  const undo = useCallback(async () => {
    if ((await undoWrite()) === "written") rereadSelections();
  }, [rereadSelections, undoWrite]);
  const redo = useCallback(async () => {
    if ((await redoWrite()) === "written") rereadSelections();
  }, [redoWrite, rereadSelections]);

  const { handleEvent, handleInstalled, handleSignals, lastInstalledKeyRef } =
    useBrowserDesignEvents({
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
    });
  const { run } = useBrowserDesignRuntime({
    active: runtimeActive,
    onEvent: handleEvent,
    onInstalled: handleInstalled,
    onSignals: handleSignals,
    probeEnabled: probeEnabled && pluginEnabled,
    webview,
    webviewGeneration,
  });
  runRef.current = run;

  // 运行时卸下（离开设计稿且不在点选）时页面已由 dispose 还原，宿主侧的临时状态一起清掉
  useEffect(() => {
    if (runtimeActive) return;
    setModeState("off");
    setPanelOpen(false);
    setSelections([]);
    latest.current.selections = [];
    setVariablePreviewState({});
    setVariantState(null);
    setPageInfo(null);
    lastInstalledKeyRef.current = null;
    detachChips();
  }, [detachChips, runtimeActive]);

  const setMode = useCallback(
    (next: DesignInteractionMode) => {
      const target = latest.current.mode === next ? "off" : next;
      // 进点选时不开面板，选中元素后才出来（11-05 用户反馈：没选中时面板是空的，还挡画板）
      if (target !== "off") onSelectModeStart?.();
      setModeState(target);
      void run({ type: "set-mode", mode: target });
      if (target === "off") {
        // 退出点选 = 退出设计模式：面板一起收起（11-05 反馈）
        setPanelOpen(false);
        void run({ type: "set-selection", selectors: [] });
        detachChips();
      }
    },
    [detachChips, onSelectModeStart, run],
  );

  const requestSelectMode = useCallback(
    () => requestPluginSelection(() => setMode("select"), latest.current.mode !== "off"),
    [requestPluginSelection, setMode],
  );

  const stopSelecting = useCallback(() => {
    if (latest.current.mode !== "off") setMode("select");
  }, [setMode]);

  // 单页应用换路由（pushState、前进后退）不会重新注入运行时：地址一换也按换页处理，退出点选（!3548 第三轮）
  const lastPageKeyRef = useRef(pageKey);
  useEffect(() => {
    // 取地址失败时会短暂退回 about:blank（导航途中、guest 重附）：不当成换页，免得同一页面重附时误退出
    if (lastPageKeyRef.current === pageKey || pageKey.startsWith("about:")) return;
    lastPageKeyRef.current = pageKey;
    stopSelecting();
  }, [pageKey, stopSelecting]);

  const selectParent = useCallback(() => {
    void run({ type: "select-parent" });
  }, [run]);

  // ---- 面板改值：预览作用于全部选中元素；提交写回源文件 ----
  const previewStyle = useCallback(
    (property: DesignStyleProperty, value: string) => {
      for (const selection of latest.current.selections) {
        void run({
          type: "set-element-properties",
          selector: selectorOf(selection),
          styles: { [DESIGN_STYLE_CSS_NAMES[property]]: value },
        });
      }
    },
    [run],
  );
  /**
   * 面板里改文字（单选、源码里只含文字）。页面读回的文字会被截到 DESIGN_PAGE_LIMITS.longText，
   * 截到上限的不让改：写回会用截断的值替换整段，尾部丢掉（!3450 CR-03）。
   */
  const commitText = useCallback(
    async (text: string) => {
      const primary = latest.current.selections.at(-1);
      if (!primary || latest.current.selections.length !== 1) return;
      if ((primary.editable.text ?? "").length >= DESIGN_PAGE_LIMITS.longText) return;
      if (text === primary.editable.text) return;
      void runLatest({ type: "set-element-text", selector: selectorOf(primary), text });
      await commitElements([{ selection: primary, text }]);
    },
    [commitElements, runLatest],
  );
  const commitStyle = useCallback(
    async (property: DesignStyleProperty, value: string) => {
      const items = latest.current.selections;
      if (items.length === 0) return;
      previewStyle(property, value);
      await commitElements(
        items.map((selection) => ({
          selection,
          styles: { [DESIGN_STYLE_CSS_NAMES[property]]: value },
        })),
      );
    },
    [commitElements, previewStyle],
  );

  const tweakControls = useMemo(
    () => buildCssVariableTweakControls(pageInfo?.cssVariables ?? []),
    [pageInfo],
  );
  const previewVariable = useCallback(
    (name: string, value: string | number) => {
      const control = tweakControls.find((item) => item.id === name);
      if (control) setVariablePreview(name, formatTweakValue(control, value));
    },
    [setVariablePreview, tweakControls],
  );
  const commitVariableValue = useCallback(
    async (name: string, value: string | number) => {
      const control = tweakControls.find((item) => item.id === name);
      if (!control) return;
      const formatted = formatTweakValue(control, value);
      setVariablePreview(name, formatted);
      // 写回失败时 writer 按这次读到的源码撤回预览
      await commitVariable(name, formatted);
    },
    [commitVariable, setVariablePreview, tweakControls],
  );

  const setVariant = useCallback(
    (next: string | null) => {
      setVariantState(next);
      void run({ type: "set-variant", variant: next });
    },
    [run],
  );

  const goToSlide = useCallback(
    (index: number) => {
      if (index < 0 || index >= slide.count) return;
      setSlide((current) => ({ ...current, index }));
      void run({ type: "go-to-slide", index });
    },
    [run, slide.count],
  );

  return {
    toolsVisible,
    mode,
    requestSelectMode,
    stopSelecting,
    pageInfo,
    panelOpen,
    setPanelOpen,
    selections,
    /** 选中的元素都能写回源码；null 表示没选中或还在查 */
    writable,
    sourceUnreadable,
    /** 文字能在面板里改：单选、源码里只含文字、没被截断 */
    textWritable:
      textWritable && (selections.at(-1)?.editable.text ?? "").length < DESIGN_PAGE_LIMITS.longText,
    commitText,
    canWriteSource: writer.canWrite,
    /** 自动刷新问：这次主 HTML 变化是不是这个 tab 自己写的（只认本 tab 的写入） */
    isOwnSourceWrite: isOwnWrite,
    sourceFileName: writer.fileName,
    selectParent,
    previewStyle,
    commitStyle,
    tweakControls,
    variablePreview,
    previewVariable,
    commitVariable: commitVariableValue,
    undo,
    redo,
    variant,
    setVariant,
    slide,
    goToSlide,
  };
}

export type BrowserDesignModeController = ReturnType<typeof useBrowserDesignMode>;
