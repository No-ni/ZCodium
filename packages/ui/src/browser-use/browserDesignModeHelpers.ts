import { browserPreviewSourceUrl } from "@zcode/shared";
import { type DesignPageSignals, type DesignSelectedElement } from "@zcode/design-runtime";

function isLocalPage(url: string): boolean {
  try {
    // 本机 HTML 在 webview 里是 zcode-html:// 预览地址，先还原成源 file:// 再判断
    const { hostname, protocol } = new URL(browserPreviewSourceUrl(url));
    return (
      protocol === "file:" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

/**
 * 设计工具自动出现的条件：页面带 `data-zcode-design`；或是本机页面（file:// / localhost）且有
 * :root CSS 变量、data-variant 方案或 section.slide。普通网站很多也声明 :root 变量，所以只对本机页面看这几项。
 */
export function shouldAutoShowDesignTools(signals: DesignPageSignals, pageUrl: string): boolean {
  if (signals.isDesignDocument) return true;
  return (
    isLocalPage(pageUrl) &&
    (signals.cssVariableNames.length > 0 || signals.variants.length > 0 || signals.slideCount > 0)
  );
}

const selectorOf = (selection: DesignSelectedElement) => selection.element.selector ?? "";

/**
 * 元素引用对账是串行的：一步卡住，之后所有点选都进不了输入框（11-05 实机复现过）。
 * webview 的 executeJavaScript 在页面导航时可能永远不返回，所以给页面命令和截图各设一个上限，
 * 超时按失败处理（读不到文档令牌就不加这次的引用，截图超时就只带文字）。main 取帧自己有 15 秒超时，这里略长。
 */
const PAGE_COMMAND_DEADLINE_MS = 3_000;

const CAPTURE_DEADLINE_MS = 20_000;

function withDeadline<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
export { isLocalPage, selectorOf, PAGE_COMMAND_DEADLINE_MS, CAPTURE_DEADLINE_MS, withDeadline };
