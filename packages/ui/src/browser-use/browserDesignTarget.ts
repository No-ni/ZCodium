// 设计工具的状态 owner（docs/browser-use/2026-11-03-browser-design-mode-spec.md）：每个浏览器 tab 一份。
// 选中集合以页面运行时上报的为准（宿主只镜像）；选中的元素作为网页元素引用进输入框；
// 属性面板改的数值经 useBrowserDesignSourceWriter 直接写回源文件，撤销也在那里。

/** 元素引用投到哪个 workspace 的输入框（与 Agent tab「选择元素」同一个出口） */
export interface DesignChipTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

import type { IFileService } from "@zcode/services";
import type { PageElementRect } from "@zcode/design-runtime";
import type { DesignRuntimeWebview } from "./useBrowserDesignRuntime.js";
export interface BrowserDesignModeInput {
  /** 按视口 rect 由 main 取帧裁剪；宿主不支持时为 undefined，引用只带文字 */
  captureElement?: (rect: PageElementRect) => Promise<ArrayBuffer | null>;
  /** 没有 workspace（Agent tab 等）时为 null，点选不进输入框 */
  chipTarget: DesignChipTarget | null;
  currentUrl: string;
  /** 写回本机源文件用的文件服务（file:// 一律走本机） */
  fileService: IFileService | undefined;
  /** 进入点选前回调，宿主据此取消正在进行的元素 chip 选择（两者都拦截页面点击） */
  onSelectModeStart?: () => void;
  isVisible: boolean;
  probeEnabled: boolean;
  remoteSessionId?: string | null;
  workspaceIdentity?: string;
  webview: DesignRuntimeWebview | null;
  webviewGeneration: number;
}
