import type { createDesignPageElements } from "./pageElements.js";
import type { createDesignOverlay } from "./pageOverlay.js";
import type { createDesignBackdrop } from "./pageBackdrop.js";
import type {
  DesignCssVariable,
  DesignInteractionMode,
  DesignPageInfo,
  DesignPageSignals,
  DesignRuntimeCommand,
  DesignRuntimeEvent,
  DesignRuntimeReply,
} from "./contract.js";
import type { ElementInspector } from "./elementInspector.js";

// 注入 guest 页面的设计运行时（docs/browser-use/2026-11-03-browser-design-mode-spec.md）。
// 和 createElementInspector 一样经 `.toString()` 序列化执行，函数体必须自包含。
// 页面状态（选中框、预览）只是投影：选中集合、样式改动、CSS 变量、当前方案的 owner 是宿主，页面刷新后由宿主重新推送。
// 页面 → 宿主：`window.postMessage({ [bridgeKey]: 1, events })`，由内置浏览器固定 guest preload 校验后
// sendToHost 转给宿主；宿主 → 页面：executeJavaScript 调 run(command)。

export interface DesignRuntimeInstallOptions {
  version: string;
  /** postMessage 信封上的命名空间键；preload 只转发带这个键的消息 */
  bridgeKey: string;
  maxCssVariables: number;
}

export function installDesignRuntime(
  options: DesignRuntimeInstallOptions,
  inspector: ElementInspector,
  readSignals: (maxCount: number) => DesignPageSignals,
  createOverlay: typeof createDesignOverlay,
  createBackdrop: typeof createDesignBackdrop,
  createPageElements: typeof createDesignPageElements,
): DesignRuntimeReply<DesignPageInfo> {
  const stateKey = "__zcodeDesignRuntime";
  type RuntimeHandle = {
    version: string;
    run: (command: DesignRuntimeCommand) => DesignRuntimeReply;
  };
  const globals = window as unknown as Record<string, RuntimeHandle | undefined>;
  const existing = globals[stateKey];
  if (existing?.version === options.version) {
    return existing.run({ type: "read-info" }) as DesignRuntimeReply<DesignPageInfo>;
  }
  existing?.run({ type: "dispose" });

  // ---- 页面 → 宿主：发给自己窗口，固定 preload 在隔离世界里收下并转给宿主 ----
  const emit = (event: DesignRuntimeEvent) => {
    window.postMessage({ [options.bridgeKey]: 1, events: [event] }, "*");
  };

  const { host, hoverBox, selectedBoxes, selectedBox, placeBox, visibleRect } = createOverlay();

  let mode: DesignInteractionMode = "off";
  let hovered: Element | null = null;
  /** 选中集合，最后一个是主选中（属性面板显示它的值） */
  let selected: Element[] = [];
  const primary = () => selected[selected.length - 1] ?? null;
  // 被覆盖前页面自己的内联值：撤销时原样恢复（含 !important），原本没有才删（!3450 CR-03）
  const cssVariableOriginals = new Map<string, { value: string; priority: string } | null>();
  let variantStyle: HTMLStyleElement | null = null;
  let activeVariant: string | null = null;
  let currentSlide = 0;
  let layoutFrame = 0;
  // 每份文档装一次运行时：同地址刷新或导航回来也会换一个新令牌。页面被放进往返缓存（BFCache）时也换：
  // 从缓存恢复的是同一份文档、同一个闭包，不换的话异步操作前后读到的令牌会重新对上（!3450 需要确认）
  const newDocumentToken = () =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let documentToken = newDocumentToken();
  const handlePageHide = () => {
    documentToken = newDocumentToken();
  };

  const isOwnNode = (node: EventTarget | null) => node === host;
  const queryOne = (selector: string) => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };

  const slides = () => Array.from(document.querySelectorAll("section.slide"));
  const readCurrentSlide = (list: Element[]) => {
    const middle = window.innerHeight / 2;
    const index = list.findIndex((slide) => {
      const rect = slide.getBoundingClientRect();
      return rect.top <= middle && rect.bottom > middle;
    });
    return index >= 0 ? index : currentSlide;
  };

  const layout = () => {
    layoutFrame = 0;
    placeBox(hoverBox, mode === "off" ? null : hovered);
    const showBoxes = mode === "select";
    selected = selected.filter((element) => element.isConnected);
    for (let index = 0; index < Math.max(selected.length, selectedBoxes.length); index += 1) {
      const { box, badge } = selectedBox(index);
      const element = showBoxes ? (selected[index] ?? null) : null;
      placeBox(box, element);
      const rect = selected.length > 1 ? visibleRect(element) : null;
      badge.style.display = rect ? "block" : "none";
      if (rect) {
        badge.textContent = String(index + 1);
        const outside = rect.top >= 20;
        Object.assign(badge.style, {
          left: `${Math.max(0, rect.left)}px`,
          top: `${outside ? rect.top - 20 : rect.top + 2}px`,
        });
      }
    }
    const list = slides();
    const slideIndex = readCurrentSlide(list);
    if (list.length > 0 && slideIndex !== currentSlide) {
      currentSlide = slideIndex;
      emit({ type: "slide-changed", index: slideIndex, count: list.length });
    }
  };
  const scheduleLayout = () => {
    if (!layoutFrame) layoutFrame = window.requestAnimationFrame(layout);
  };

  const isOwnElement = (element: Element) => element.hasAttribute("data-zcode-design-runtime");
  const sourceChildren = (parent: Element) =>
    Array.from(parent.children).filter((child) => !isOwnElement(child));

  const pageElements = createPageElements(inspector, host, sourceChildren, queryOne);
  const backdrop = createBackdrop(sourceChildren, isOwnElement);
  const updateStage = () => backdrop.update();

  // resize 后跨过阈值：告诉宿主同步外框与 webview 底色（只影响外观，页面伪造也写不了源码，!3450 CR-02）
  const handleStageResize = () => {
    if (updateStage()) emit({ type: "stage-changed", stageBackdrop: backdrop.isStage });
  };
  const handleMouseMove = (event: MouseEvent) => {
    if (mode === "off" || isOwnNode(event.target) || !(event.target instanceof Element)) return;
    hovered = !event.altKey && backdrop.isPageBackdrop(event.target) ? null : event.target;
    scheduleLayout();
  };
  // 点到按钮 / 链接里的文字或图标时，选中按钮本身（设计师心里点的是按钮）
  const meaningfulTarget = (target: Element) =>
    target.closest("button,a,[role=button],label,summary") ?? target;
  const reportSelection = () => {
    emit({ type: "selection-changed", selections: selected.map(pageElements.describe) });
    scheduleLayout();
  };
  const setSelected = (next: Element[]) => {
    selected = next;
    reportSelection();
  };
  const handleClick = (event: MouseEvent) => {
    if (mode === "off" || !(event.target instanceof Element) || isOwnNode(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const target = meaningfulTarget(event.target);
    // 点到页面背景什么都不变：不选中它，也不清掉已选的（清掉会把输入框里正在描述的元素引用一起撤掉）
    if (!event.altKey && backdrop.isPageBackdrop(target)) return;
    // Shift + 点击：加进 / 移出选中（像 Figma）；普通点击替换选中
    if (event.shiftKey) {
      setSelected(
        selected.includes(target)
          ? selected.filter((element) => element !== target)
          : [...selected, target],
      );
      return;
    }
    // 已经是唯一选中也重新上报：引用随消息发出后，再点同一元素要能重新引用进输入框（宿主对账，不会重复加）
    setSelected([target]);
  };
  // 点选时按下鼠标不让浏览器开始选文字：Shift + 点击多选会把两次点击之间的文字整段选中（11-05 反馈）
  const handleMouseDown = (event: MouseEvent) => {
    if (mode === "off" || !(event.target instanceof Element) || isOwnNode(event.target)) return;
    event.preventDefault();
  };
  // Bugfix（!3450 CR-01）：页面能伪造发给宿主的消息，所以页面这边不再有任何会引起写回的事件
  //（以前的双击改字 / 拖圆点改留白 / 页面里的 Cmd+Z 都改到宿主侧：面板字段、main 的可信键盘事件）。
  const handleKeyDown = (event: KeyboardEvent) => {
    if (mode === "off" || event.key !== "Escape") return;
    event.preventDefault();
    setMode("off");
    emit({ type: "mode-changed", mode: "off" });
  };
  const setMode = (next: DesignInteractionMode) => {
    mode = next;
    document.documentElement.style.cursor = next === "off" ? "" : "crosshair";
    if (next === "off") hovered = null;
    scheduleLayout();
  };

  const setElementStyle = (selector: string, style: string | null) => {
    const element = queryOne(selector);
    if (!(element instanceof HTMLElement)) return false;
    if (style === null || style === "") element.removeAttribute("style");
    else element.setAttribute("style", style);
    scheduleLayout();
    return true;
  };
  const setElementProperties = (selector: string, styles: Record<string, string>) => {
    const element = queryOne(selector);
    if (!(element instanceof HTMLElement)) return false;
    // 预览也保留原来的 !important，和写回的源码一致（!3450 CR-01）：自己或相关的简写 / 分项带 !important 就按 important 设（SG-01）
    // 与 sourceEdit 的 RELATED_STYLE_PROPERTIES 是同一份；这里随运行时 toString 注入，不能 import
    const related: Record<string, readonly string[]> = {
      "background-color": ["background"],
      "font-size": ["font"],
      "font-weight": ["font"],
      padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
      "border-radius": [
        "border-top-left-radius",
        "border-top-right-radius",
        "border-bottom-right-radius",
        "border-bottom-left-radius",
      ],
    };
    for (const [property, value] of Object.entries(styles)) {
      const important = [property, ...(related[property] ?? [])].some(
        (name) => element.style.getPropertyPriority(name) === "important",
      );
      element.style.setProperty(property, value, important ? "important" : "");
    }
    scheduleLayout();
    return true;
  };
  const setElementText = (selector: string, text: string) => {
    const element = queryOne(selector);
    if (!(element instanceof HTMLElement)) return false;
    if (element.textContent !== text) element.textContent = text;
    scheduleLayout();
    return true;
  };

  const readCssVariables = (names: readonly string[]): DesignCssVariable[] => {
    const computed = window.getComputedStyle(document.documentElement);
    return names.map((name) => ({ name, value: computed.getPropertyValue(name).trim() }));
  };
  const setCssVariables = (values: Record<string, string>) => {
    const rootStyle = document.documentElement.style;
    for (const [name, original] of cssVariableOriginals) {
      if (name in values) continue;
      if (original) rootStyle.setProperty(name, original.value, original.priority);
      else rootStyle.removeProperty(name);
      cssVariableOriginals.delete(name);
    }
    for (const [name, value] of Object.entries(values)) {
      if (!name.startsWith("--")) continue;
      if (!cssVariableOriginals.has(name)) {
        const existing = rootStyle.getPropertyValue(name);
        cssVariableOriginals.set(
          name,
          existing ? { value: existing, priority: rootStyle.getPropertyPriority(name) } : null,
        );
      }
      // 原值带 !important 时预览也要带，否则盖不过它
      rootStyle.setProperty(name, value, cssVariableOriginals.get(name)?.priority ?? "");
    }
    scheduleLayout();
  };

  const setVariant = (variant: string | null) => {
    variantStyle?.remove();
    variantStyle = null;
    activeVariant = variant;
    if (variant === null) {
      document.documentElement.removeAttribute("data-zcode-active-variant");
    } else {
      variantStyle = document.createElement("style");
      variantStyle.setAttribute("data-zcode-design-runtime", "variant");
      variantStyle.textContent = `body [data-variant]:not([data-variant="${CSS.escape(variant)}"]){display:none !important}`;
      document.head.append(variantStyle);
      document.documentElement.setAttribute("data-zcode-active-variant", variant);
    }
    scheduleLayout();
  };

  const readInfo = (): DesignPageInfo => {
    const list = slides();
    currentSlide = readCurrentSlide(list);
    const signals = readSignals(options.maxCssVariables);
    return {
      pageUrl: location.href,
      pageTitle: document.title,
      isDesignDocument: signals.isDesignDocument,
      variants: signals.variants,
      activeVariant,
      slideCount: list.length,
      currentSlide,
      cssVariables: readCssVariables(signals.cssVariableNames),
      stageBackdrop: (updateStage(), backdrop.isStage),
    };
  };

  const observer = new MutationObserver(scheduleLayout);
  const dispose = () => {
    setMode("off");
    setCssVariables({});
    setVariant(null);
    observer.disconnect();
    backdrop.dispose();
    window.removeEventListener("resize", handleStageResize);
    if (layoutFrame) window.cancelAnimationFrame(layoutFrame);
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("mousedown", handleMouseDown, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("scroll", scheduleLayout, true);
    window.removeEventListener("resize", scheduleLayout);
    window.removeEventListener("pagehide", handlePageHide);
    document.documentElement.style.cursor = "";
    host.remove();
    delete globals[stateKey];
  };

  const run = (command: DesignRuntimeCommand): DesignRuntimeReply => {
    switch (command.type) {
      case "set-mode":
        setMode(command.mode);
        return { ok: true, result: null };
      case "set-selection": {
        const elements = command.selectors
          .map(queryOne)
          .filter((element): element is Element => element !== null);
        setSelected(elements);
        return { ok: true, result: null };
      }
      case "set-element-style":
        return { ok: true, result: setElementStyle(command.selector, command.style) };
      case "set-element-properties":
        return { ok: true, result: setElementProperties(command.selector, command.styles) };
      case "set-element-text":
        return { ok: true, result: setElementText(command.selector, command.text) };
      case "select-parent": {
        const current = primary();
        const parent = current?.parentElement;
        if (!current || !parent || parent === document.documentElement || current === document.body)
          return { ok: true, result: false };
        setSelected([...selected.slice(0, -1).filter((element) => element !== parent), parent]);
        return { ok: true, result: true };
      }
      case "set-css-variables":
        setCssVariables(command.values);
        return { ok: true, result: null };
      case "set-variant":
        setVariant(command.variant);
        return { ok: true, result: null };
      case "go-to-slide": {
        const target = slides()[command.index];
        target?.scrollIntoView({ block: "start" });
        return { ok: true, result: Boolean(target) };
      }
      case "locate-for-capture":
        return { ok: true, result: pageElements.locateForCapture(command.selector) };
      case "end-capture":
        host.style.display = "";
        scheduleLayout();
        return { ok: true, result: null };
      case "read-info":
        return { ok: true, result: readInfo() };
      case "read-document-token":
        return { ok: true, result: documentToken };
      case "dispose":
        dispose();
        return { ok: true, result: null };
      default:
        return { ok: false, reason: "invalid" };
    }
  };

  document.addEventListener("mousemove", handleMouseMove, true);
  document.addEventListener("click", handleClick, true);
  document.addEventListener("mousedown", handleMouseDown, true);
  document.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("scroll", scheduleLayout, { capture: true, passive: true });
  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("resize", handleStageResize);
  window.addEventListener("pagehide", handlePageHide);
  observer.observe(document.documentElement, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  globals[stateKey] = { version: options.version, run };
  return { ok: true, result: readInfo() };
}
