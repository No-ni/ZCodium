import type { MouseEvent, ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { FileApplicationInfo } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { DefaultFileApplicationLabel } from "@/file-menu/index.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

interface OpenSplitButtonTriggerProps {
  hideOpenWithMenu: boolean;
  canPreview: boolean;
  openDefaultOnPrimary: boolean;
  defaultApplication?: FileApplicationInfo | null;
  defaultApplicationTitle: string;
  intl: IntlInstance;
  onPrimaryClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onOpenChange: (open: boolean) => void;
  onStopPropagation: (event: { stopPropagation: () => void }) => void;
  viewMenuItems?: ReactNode;
  dropdownActions: ReactNode;
}

// 纯展示：只接收父组件算好的可用状态与 handler，不持有 state、不调用服务。
export function OpenSplitButtonTrigger({
  hideOpenWithMenu,
  canPreview,
  openDefaultOnPrimary,
  defaultApplication,
  defaultApplicationTitle,
  intl,
  onPrimaryClick,
  onOpenChange,
  onStopPropagation,
  viewMenuItems,
  dropdownActions,
}: OpenSplitButtonTriggerProps) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
        onClick={onStopPropagation}
        onPointerDown={onStopPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="default"
          className={`h-7 rounded-none border-0 gap-1 ${hideOpenWithMenu ? "px-2" : "pr-1.5"}`}
          disabled={!canPreview}
          title={openDefaultOnPrimary ? defaultApplicationTitle : undefined}
          aria-label={openDefaultOnPrimary ? defaultApplicationTitle : undefined}
          onClick={onPrimaryClick}
        >
          {openDefaultOnPrimary ? (
            <DefaultFileApplicationLabel application={defaultApplication}>
              {intl.formatMessage({ id: "common.open" })}
            </DefaultFileApplicationLabel>
          ) : (
            intl.formatMessage({ id: "common.open" })
          )}
        </Button>
        {!hideOpenWithMenu && (
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              className="!w-5 rounded-none border-0 text-foreground-subtlest"
              aria-label={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
              title={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
              onClick={onStopPropagation}
            >
              <ChevronDownIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        )}
      </div>
      {!hideOpenWithMenu && (
        <DropdownMenuContent
          align="end"
          side="top"
          className="w-64 max-w-[calc(100vw-1rem)]"
          onClick={onStopPropagation}
        >
          {dropdownActions}
          {viewMenuItems ? (
            <>
              <DropdownMenuSeparator />
              {viewMenuItems}
            </>
          ) : null}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
