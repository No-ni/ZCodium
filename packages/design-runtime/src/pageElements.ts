import type { DesignSourcePath, DesignSelectedElement, PageElementRect } from "./contract.js";
import type { ElementInspector } from "./elementInspector.js";
// 自包含注入工厂只读取原页面节点/inspector；宿主命令与选择 owner 不变。
export function createDesignPageElements(
  inspector: ElementInspector,
  host: HTMLElement,
  sourceChildren: (parent: Element) => Element[],
  queryOne: (selector: string) => Element | null,
) {
  // 元素在源码里的位置：从 <html> 往下每级的标签、序号、兄弟数（运行时自己的节点不算）。
  // 走不到 <html>（shadow DOM 里的元素）时给一级不可能对上的路径，宿主写回时自然找不到。
  const sourcePath = (element: Element): DesignSourcePath => {
    const steps: DesignSourcePath["steps"] = [];
    let node: Element = element;
    while (node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) {
        steps.unshift({ tag: "#detached", index: -1, siblings: -1 });
        break;
      }
      const children = sourceChildren(parent);
      steps.unshift({
        tag: node.tagName.toLowerCase(),
        index: children.indexOf(node),
        siblings: children.length,
      });
      node = parent;
    }
    return { steps, id: element.getAttribute("id"), className: element.getAttribute("class") };
  };
  const describe = (element: Element): DesignSelectedElement => {
    const rect = element.getBoundingClientRect();
    return {
      element: inspector.collectElement(element),
      editable: inspector.readEditableValues(element),
      kind: inspector.classifyElement(element),
      source: sourcePath(element),
      size: { width: Math.round(rect.width), height: Math.round(rect.height) },
      styleAttribute: element.getAttribute("style"),
    };
  };
  const locateForCapture = (selector: string): PageElementRect | null => {
    const element = queryOne(selector);
    if (!element) return null;
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    host.style.display = "none";
    const box = element.getBoundingClientRect();
    // 标题、段落这类块级文字元素占满整行，文字只在一侧：截文字实际占的范围（四周留一点），
    // 否则截图大半是空白，输入框里按中间裁的缩略图看起来就是一张白图
    if (inspector.isTextEditable(element)) {
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      if (text.width > 0 && text.height > 0 && text.width < box.width * 0.8) {
        const pad = 8;
        const left = Math.max(box.left, text.left - pad);
        const top = Math.max(box.top, text.top - pad);
        const right = Math.min(box.right, text.right + pad);
        const bottom = Math.min(box.bottom, text.bottom + pad);
        return { x: left, y: top, width: right - left, height: bottom - top };
      }
    }
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };

  return { describe, locateForCapture };
}
