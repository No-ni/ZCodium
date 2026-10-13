import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 创建/修订/补全共用的脚本审计折叠；独立局部状态，不参与 run 或审批状态。 */
export function WorkflowScriptFold({ script }: { script: string }) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle"
        data-testid="workflow-card-script-toggle"
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 truncate">
          {intl.formatMessage({
            id: open
              ? "chat.permission.workflow.hideScript"
              : "chat.permission.workflow.showScript",
          })}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1.5">
        <div className="max-h-72 overflow-auto">
          <CodeBlock code={script} language="typescript" renderMermaid={false} showLineNumbers />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
