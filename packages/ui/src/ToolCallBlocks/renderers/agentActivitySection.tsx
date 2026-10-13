import { MessageResponse } from "@/components/ai-elements/message.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

/**
 * Agent 卡片展开区的活动段落（thought / output）。
 *
 * 从 `agent.tsx` 抽出：该文件已顶到 eslint `max-lines`（400 代码行）上限，
 * 而这一段有自己的 markdown 解析根透传（`fileReferenceRootPath`），是内聚的展示单元。
 */
export function AgentActivitySection({
  label,
  content,
  workspacePath,
  fileReferenceRootPath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  label: string;
  content: string;
  /** 工作区身份根：markdown 的 payload/作用域；语义不要改。 */
  workspacePath: string;
  /** Agent 活动内容里的相对链接是模型/子代理写的：解析根 = 会话执行 cwd，缺省回落身份根。 */
  fileReferenceRootPath?: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
}) {
  return (
    <section className="space-y-2">
      <div className="rounded-lg border border-border bg-background-alt/40 flex flex-col">
        <h4 className="p-3 text-ui-base font-medium tracking-wide text-foreground-subtlest uppercase">
          {label}
        </h4>
        <div className="overflow-auto max-h-64" data-markdown-table-sticky-scrollbar="disabled">
          {/* Agent 活动内容同样可能包含长代码/路径，允许横向滚动避免窄屏截断。*/}
          <MessageResponse
            className="px-3 py-2 min-w-0 break-words text-ui-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            workspacePath={workspacePath}
            fileReferenceRootPath={fileReferenceRootPath ?? workspacePath}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            onOpenCodeViewer={onOpenCodeViewer}
            onOpenFileLink={onOpenFileLink}
            onOpenExternalUrl={onOpenBrowserUrl}
          >
            {content}
          </MessageResponse>
        </div>
      </div>
    </section>
  );
}
