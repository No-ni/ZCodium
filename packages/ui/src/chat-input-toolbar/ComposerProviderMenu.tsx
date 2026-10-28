import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu.js";
import { TID_CHAT_MODEL_SELECT_GROUP, testId } from "@zcode/shared";

const NARROW_MENU_QUERY = "(max-width: 639px)";
function subscribeNarrowMenu(listener: () => void) {
  const media = window.matchMedia(NARROW_MENU_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
function isNarrowMenu() {
  return window.matchMedia(NARROW_MENU_QUERY).matches;
}

/** 只拥有供应商浏览页的开关；模型选择始终回到 Composer 原 owner。 */
export function ComposerProviderMenu({
  groups,
  group,
  selectedKey,
  label,
  pending = false,
  providerFooter,
  onSelect,
  children,
}: {
  groups: readonly ModelSelectGroup[];
  group: ModelSelectGroup | undefined;
  selectedKey?: string;
  label: string;
  pending?: boolean;
  providerFooter?: ReactNode;
  onSelect: (group: ModelSelectGroup) => void;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const narrow = useSyncExternalStore(subscribeNarrowMenu, isNarrowMenu, () => false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wasNarrowPageRef = useRef(false);
  useLayoutEffect(() => {
    // 窄屏同层页面会卸载原焦点项；布局完成后直接交接焦点，不能靠延迟聚焦掩盖同步。
    if (narrow && open) {
      const list = listRef.current;
      const selected = list?.querySelector<HTMLElement>(
        '[role="menuitemradio"][aria-checked="true"]',
      );
      const first = list?.querySelector<HTMLElement>('[role="menuitemradio"]:not([data-disabled])');
      (selected ?? first ?? list?.querySelector<HTMLElement>('[role="menuitem"]'))?.focus();
    } else if (wasNarrowPageRef.current) {
      triggerRef.current?.focus();
    }
    wasNarrowPageRef.current = narrow && open;
  }, [narrow, open]);

  const contents = (
    <>
      <DropdownMenuRadioGroup
        ref={listRef}
        value={selectedKey ?? ""}
        data-composer-provider-list
        className="min-h-0 overflow-y-auto"
      >
        {groups.map((candidate) => (
          <DropdownMenuRadioItem
            key={candidate.key}
            value={candidate.key}
            disabled={pending}
            aria-label={candidate.label}
            data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, candidate.key)}
            data-model-provider-key={candidate.key}
            data-model-provider-selected={candidate.key === selectedKey ? "true" : undefined}
            className="min-h-8 gap-2 pl-2 pr-8"
            onSelect={(event) => {
              event.preventDefault();
              onSelect(candidate);
              setOpen(false);
            }}
          >
            <span className="min-w-0 whitespace-normal break-words">{candidate.label}</span>
            {candidate.labelBadge ? (
              <span className="shrink-0 rounded-full bg-surface px-1 py-px text-ui-xs text-foreground-subtle">
                {candidate.labelBadge}
              </span>
            ) : null}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {providerFooter ? (
        <>
          {groups.length > 0 ? <DropdownMenuSeparator className="shrink-0" /> : null}
          {providerFooter}
        </>
      ) : null}
    </>
  );
  const title = (
    <span className="min-w-0 flex-1 whitespace-normal break-words">{group?.label ?? label}</span>
  );
  const triggerProps = {
    "data-testid": "composer-provider-trigger",
    "aria-label": group ? `${label}: ${group.label}` : label,
    "aria-busy": pending || undefined,
    disabled: pending || (!group && !providerFooter),
    className: "min-h-8 shrink-0 gap-2",
  };

  if (narrow) {
    return open ? (
      <>
        <DropdownMenuItem
          data-testid="composer-provider-back"
          className="shrink-0"
          onSelect={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <ChevronLeftIcon aria-hidden="true" />
          {intl.formatMessage({ id: "common.back" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="shrink-0" />
        {contents}
      </>
    ) : (
      <>
        <DropdownMenuItem
          {...triggerProps}
          ref={triggerRef}
          aria-haspopup="menu"
          aria-expanded={open}
          onSelect={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          {title}
          <ChevronRightIcon aria-hidden="true" className="ml-auto size-4 text-foreground-subtle" />
        </DropdownMenuItem>
        {children}
      </>
    );
  }
  return (
    <>
      <DropdownMenuSub open={open} onOpenChange={setOpen}>
        <DropdownMenuSubTrigger {...triggerProps} ref={triggerRef}>
          {title}
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent
            collisionPadding={12}
            className="z-[61] w-max min-w-0 max-w-(--radix-dropdown-menu-content-available-width) max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto [app-region:no-drag]"
          >
            {contents}
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
      {children}
    </>
  );
}
