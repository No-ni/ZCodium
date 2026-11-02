import type { ReactElement, ReactNode } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

// 导出类型供共用时间线以 import type 引用（构建期擦除，不把 open-with 子树带进公开页 bundle）。
export type OpenSplitButtonTarget =
  | {
      type: "website";
      url: string;
      localPath?: string;
      workspacePath?: string;
    }
  | {
      type: "file";
      path: string;
      title: string;
      label: string;
      previewSource?: CodeViewerSource;
    };

export interface OpenSplitButtonProps {
  target: OpenSplitButtonTarget;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  hideOpenWithMenu?: boolean;
  openDefaultOnPrimary?: boolean;
  /** 预览专属的显示选项，追加在统一文件动作之后，不复制文件操作。 */
  viewMenuItems?: ReactNode;
  stopPropagation?: boolean;
  /** 整张卡片复用按钮的操作与状态，右键和下拉不会维护两套动作。 */
  renderCard?: (
    button: ReactNode,
    /** 卡片主体整卡点击复用主按钮的预览动作与可用状态。 */
    actions: { handlePreview: () => void; canPreview: boolean },
  ) => ReactElement;
}
