import { Maximize2Icon, Minimize2Icon, MessageCircleIcon } from "lucide-react";
import {
  TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB,
  TID_SIDE_PANE_FULL_VIEW_TOGGLE,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { TabsTrigger } from "@/components/ui/tabs.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export const SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE = "__side-pane-full-view-conversation__";
export function SidePaneFullViewToggleButton({
  active,
  onToggle,
  shortcutLabel,
}: {
  active: boolean;
  onToggle: () => void;
  shortcutLabel?: string;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({
    id: active ? "sidePane.fullView.exit" : "sidePane.fullView.enter",
  });
  const Icon = active ? Minimize2Icon : Maximize2Icon;
  return (
    <ControlHintTooltip title={label} shortcut={shortcutLabel} side="bottom" align="end">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid={TID_SIDE_PANE_FULL_VIEW_TOGGLE}
        data-active={active ? "true" : "false"}
        aria-label={label}
        aria-pressed={active}
        className="[app-region:no-drag]"
        onClick={onToggle}
      >
        <Icon className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}
export function SidePaneFullViewConversationTab({
  title,
  isActive,
}: {
  title: string;
  isActive: boolean;
}) {
  return (
    <TabsTrigger value={SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE} asChild>
      <button
        type="button"
        title={title}
        data-testid={TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB}
        data-active={isActive ? "true" : "false"}
        className="!h-7 max-w-60 shrink-0 justify-start overflow-hidden rounded-lg border-0 px-2 text-ui-base font-medium [app-region:no-drag]"
      >
        <MessageCircleIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{title}</span>
      </button>
    </TabsTrigger>
  );
}
