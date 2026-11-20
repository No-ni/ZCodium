// 由宿主序列化注入；源码节点读口由同一页面运行时提供，不引用宿主模块。
export function createDesignBackdrop(
  sourceChildren: (parent: Element) => Element[],
  isOwnElement: (element: Element) => boolean,
) {
  // 页面背景：<html>、<body>，以及从 body 一路唯一子元素下来、和 body 一样大的外层容器（设计稿常把整页底色画在这里）。
  // 点它不选中、悬停也不画框，否则一点空白处就选中整页、盖住想调的元素（11-05 体验反馈）。按住 Option / Alt 仍能选中它改底色。
  const LAYOUT_TAGS = new Set([
    "DIV",
    "MAIN",
    "SECTION",
    "ARTICLE",
    "ASIDE",
    "HEADER",
    "FOOTER",
    "NAV",
    "FORM",
  ]);
  const isLayoutContainer = (element: Element) =>
    LAYOUT_TAGS.has(element.tagName) &&
    !Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
    );
  const backdropChain = (): Element[] => {
    const body = document.body;
    if (!body) return [document.documentElement];
    const chain: Element[] = [document.documentElement, body];
    const bodyRect = body.getBoundingClientRect();
    let node: Element = body;
    while (true) {
      const children = sourceChildren(node);
      if (children.length !== 1) return chain;
      const child = children[0]!;
      // 只穿过布局容器：标题、段落、按钮、图片这类内容，或自己直接带文字的元素，是用户要选的东西，不是背景（!3450 CR-03）
      if (!isLayoutContainer(child)) return chain;
      const rect = child.getBoundingClientRect();
      if (
        Math.abs(rect.width - bodyRect.width) > 2 ||
        Math.abs(rect.height - bodyRect.height) > 2
      ) {
        return chain;
      }
      chain.push(child);
      node = child;
    }
  };
  // 舞台式页面：页面底色上摆着几块自带底色的画板（常见是并排的手机稿），而直接落在底色上的文字在深色画布上也看得清。
  // 设计模式里把这层底色在预览里设成透明，画板直接落在宿主的画布上，不再「画布里套一块页面底」（11-05 体验反馈）。
  // 落地页这类整页就是画板的（深色标题直接压在浅底上）不算，保持原样。只改预览，不动源码。
  const hasOwnBackground = (element: Element) => {
    const style = getComputedStyle(element);
    return (
      style.backgroundImage !== "none" ||
      !/^rgba\(.*,\s*0\)$|^transparent$/u.test(style.backgroundColor)
    );
  };
  const isLightColor = (color: string) => {
    const [r = 0, g = 0, b = 0, a = 1] = (color.match(/[\d.]+/gu) ?? []).map(Number);
    return a === 0 || (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55;
  };
  const STAGE_SCAN_LIMIT = 3000;
  const findBoards = (): Element[] => {
    const boards: Element[] = [];
    const elements = document.body ? document.body.querySelectorAll("*") : [];
    for (let index = 0; index < elements.length && index < STAGE_SCAN_LIMIT; index += 1) {
      const element = elements[index]!;
      if (isOwnElement(element) || boards.some((board) => board.contains(element))) continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.width >= 160 &&
        rect.height >= 160 &&
        rect.width <= window.innerWidth * 0.7 &&
        hasOwnBackground(element)
      ) {
        boards.push(element);
      }
    }
    return boards;
  };
  // 不在画板里的文字都要在深色画布上看得清（文字所在元素往上找到画板或有底色的元素之前，都算落在页面底上）
  const textOnBackdropIsLight = (boards: Element[], chain: Element[]) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let count = 0; count < STAGE_SCAN_LIMIT; count += 1) {
      const node = walker.nextNode();
      if (!node) return true;
      const parent = node.parentElement;
      // 没渲染出来的文字（display: none 的说明、<script> 源码）不算
      if (!parent || !node.textContent?.trim() || parent.getClientRects().length === 0) continue;
      if (boards.some((board) => board.contains(parent))) continue;
      // 往上找最近的有底色元素；找到的是背景链里的（马上要设成透明），文字就等于直接压在画布上（!3450 CR-01）
      let painted: Element | null = parent;
      while (painted && !chain.includes(painted) && !hasOwnBackground(painted)) {
        painted = painted.parentElement;
      }
      const onBackdrop = !painted || chain.includes(painted);
      if (onBackdrop && !isLightColor(getComputedStyle(parent).color)) return false;
    }
    return true;
  };
  let stageBoards: Element[] = [];
  // 舞台页里的页面背景：html / body / 撑满的外层容器，以及包着画板、自己没有底色的布局容器
  const isPageBackdrop = (element: Element) =>
    backdropChain().includes(element) ||
    (stageBoards.length > 0 &&
      !stageBoards.some((board) => board.contains(element)) &&
      stageBoards.some((board) => element.contains(board)) &&
      !hasOwnBackground(element));
  // 按页面原始底色判断：先撤掉自己注入的透明样式，否则下一次判断会把上一次的结果当成页面本来的样子（!3450 CR-01）
  const stageBackdrop = (): Element[] | null => {
    stageStyle.remove();
    const chain = backdropChain();
    const boards = findBoards().filter((board) => !chain.includes(board));
    // 内容要滚动（超出视口）就不算舞台页：页面底透明后视口边界看不见，超出视口的画板会像被凭空截断（11-05 实机）
    const root = document.documentElement;
    const fitsViewport =
      root.scrollHeight <= window.innerHeight + 1 && root.scrollWidth <= window.innerWidth + 1;
    stageBoards =
      fitsViewport && boards.length > 0 && textOnBackdropIsLight(boards, chain) ? boards : [];
    return stageBoards.length > 0 ? chain : null;
  };
  const stageStyle = document.createElement("style");
  stageStyle.setAttribute("data-zcode-design-runtime", "");
  const backdropSelector = (element: Element): string => {
    if (element === document.documentElement) return "html";
    if (element === document.body) return "body";
    const parent = element.parentElement!;
    return `${backdropSelector(parent)} > :nth-child(${Array.from(parent.children).indexOf(element) + 1})`;
  };
  let isStage = false;
  const updateStage = () => {
    const chain = stageBackdrop();
    const changed = isStage !== (chain !== null);
    isStage = chain !== null;
    stageStyle.textContent = chain
      ? `${chain.map(backdropSelector).join(",")}{background:transparent!important;box-shadow:none!important}`
      : "";
    if (isStage && !stageStyle.isConnected)
      (document.head ?? document.documentElement).append(stageStyle);
    if (!isStage) stageStyle.remove();
    return changed;
  };

  return {
    isPageBackdrop,
    update: updateStage,
    dispose: () => stageStyle.remove(),
    get isStage() {
      return isStage;
    },
  };
}
