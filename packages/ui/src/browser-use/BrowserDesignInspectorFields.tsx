import { useRef, useState } from "react";
import { TID_BROWSER_DESIGN_SOURCE_STATUS } from "@zcode/shared/test-ids";
import { type Translate } from "@/browser-use/BrowserDesignFields.js";
import type { BrowserDesignModeController } from "@/browser-use/useBrowserDesignMode.js";
import { cn } from "@/components/lib/utils.js";

/** 只在写不回时说明原因；能写回是默认情况，不占面板（11-05 反馈） */
function SourceStatus({ design, t }: { design: BrowserDesignModeController; t: Translate }) {
  const message = !design.canWriteSource
    ? t("browser.design.source.pageUnavailable")
    : design.sourceUnreadable
      ? t("browser.design.source.unreadable")
      : design.writable === false
        ? t("browser.design.source.notMatched")
        : null;
  return (
    <p
      className={cn("px-3 text-ui-xs text-warning", message ? "py-2" : "hidden")}
      data-testid={TID_BROWSER_DESIGN_SOURCE_STATUS}
      data-writable={design.canWriteSource && design.writable === true}
    >
      {message}
    </p>
  );
}

/** 元素文字：回车或失焦提交，Esc 放弃；源码里只含文字的元素才出（写回只替换纯文字） */
function TextContentField({
  label,
  onCommit,
  value,
}: {
  label: string;
  onCommit: (value: string) => void;
  value: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Esc 放弃输入：blur 同步触发 onBlur 时 draft 还没清掉，靠这个标记跳过提交（!3450 CR-03）
  const cancelledRef = useRef(false);
  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (draft === null) return;
    setDraft(null);
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      aria-label={label}
      className="h-7 w-full min-w-0 rounded-md border border-input-border bg-input px-2 text-ui-sm outline-none hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused"
      data-design-draft={draft !== null}
      data-design-field="text"
      placeholder={label}
      value={draft ?? value}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) commit();
        if (event.key === "Escape") {
          cancelledRef.current = true;
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
export { SourceStatus, TextContentField };
