import { XIcon } from "lucide-react";
import {
  TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE,
  TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE,
} from "@zcode/shared";
import type { FloatingAnchor } from "../contract.js";
import { resolveFloatingAnswerPreview } from "../domain/model.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function FloatingAnswerBubble({
  anchor,
  text,
  onOpen,
  onDismiss,
}: {
  anchor: FloatingAnchor;
  text: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-testid={TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE}
      className={cn(
        "absolute inset-x-0 z-20",
        anchor.startsWith("top") ? "top-full mt-2" : "bottom-full mb-2",
      )}
    >
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "sidePane.fullView.openAnswer" })}
        className="block w-full rounded-xl border border-border bg-popover px-4 py-3 text-left shadow-lg hover:bg-hover"
        onClick={onOpen}
      >
        <span className="line-clamp-2 text-ui-base text-foreground">
          {resolveFloatingAnswerPreview(text)}
        </span>
      </button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        data-testid={TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE}
        aria-label={intl.formatMessage({ id: "common.close" })}
        className="absolute -top-2 -left-2 bg-popover shadow-sm"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onDismiss}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}
