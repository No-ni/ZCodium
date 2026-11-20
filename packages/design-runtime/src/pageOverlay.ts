// 由宿主序列化注入，函数只使用页面全局；浮层集合仍是原运行时的同一投影。
export function createDesignOverlay() {
  // ---- 浮层：放进 closed shadow root，页面样式影响不到，也不参与命中测试 ----
  const host = document.createElement("div");
  host.setAttribute("data-zcode-design-runtime", "");
  Object.assign(host.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "0",
    height: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  const shadow = host.attachShadow({ mode: "closed" });
  const sheet = document.createElement("style");
  sheet.textContent = [
    ".box{position:fixed;box-sizing:border-box;border-radius:4px;pointer-events:none;display:none}",
    ".hover{border:2px solid #2563eb;background:rgba(37,99,235,.10)}",
    ".selected{border:2px solid #7c3aed;background:rgba(124,58,237,.08)}",
    // 多选时的序号：贴在选中框左上角外侧（放不下时放进框里），压在所有框上面，不会被后画的框盖住
    ".badge{position:fixed;display:none;z-index:2;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;",
    "border-radius:4px;background:#7c3aed;color:#fff;font:600 11px/18px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;",
    "text-align:center;white-space:nowrap;pointer-events:none}",
  ].join("");
  const createBox = (className: string) => {
    const box = document.createElement("div");
    box.className = `box ${className}`;
    shadow.append(box);
    return box;
  };
  shadow.append(sheet);
  const hoverBox = createBox("hover");
  // 选中框按需加：每个选中元素一个框 + 一个序号
  const selectedBoxes: Array<{ box: HTMLElement; badge: HTMLElement }> = [];
  const selectedBox = (index: number) => {
    while (selectedBoxes.length <= index) {
      const badge = document.createElement("div");
      badge.className = "badge";
      shadow.append(badge);
      selectedBoxes.push({ box: createBox("selected"), badge });
    }
    return selectedBoxes[index]!;
  };
  document.documentElement.append(host);

  const placeBox = (box: HTMLElement, element: Element | null) => {
    const rect = element?.isConnected ? element.getBoundingClientRect() : null;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      box.style.display = "none";
      return;
    }
    Object.assign(box.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };

  const visibleRect = (element: Element | null) => {
    const rect = element?.isConnected ? element.getBoundingClientRect() : null;
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    if (
      rect.bottom < 0 ||
      rect.right < 0 ||
      rect.top > window.innerHeight ||
      rect.left > window.innerWidth
    )
      return null;
    return rect;
  };

  return { host, hoverBox, selectedBoxes, selectedBox, placeBox, visibleRect };
}
