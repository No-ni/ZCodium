import { useRef, useState, type ReactNode } from "react";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { Kbd } from "@/components/ui/kbd.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";
import { ComposerProviderMenu } from "@/chat-input-toolbar/ComposerProviderMenu.js";
import { isNoThoughtLevel } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";

export interface ComposerModelOptions {
  providerLabel: string;
  modelsLabel: string;
  effortLabel: string;
  effortShortcutLabel?: string;
  selectModelLabel: string;
  /** 原 Host 目录重读时保留控件与焦点，但不把目录当成已解析选择。 */
  pending?: boolean;
  levels: readonly { value: string; label: string }[];
  value: string;
  onValueChange: (value: string) => void;
}

export function getComposerThoughtDisplay(options: ComposerModelOptions) {
  const current = options.levels.find((level) => level.value === options.value);
  const thinking = options.levels.filter((level) => !isNoThoughtLevel(level));
  const progress =
    current && !isNoThoughtLevel(current) && thinking.length > 0
      ? ((thinking.findIndex((level) => level.value === current.value) + 1) / thinking.length) * 100
      : 0;
  return { label: current?.label ?? "—", progress };
}

export function ComposerThoughtIndicator({ options }: { options: ComposerModelOptions }) {
  const { label, progress } = getComposerThoughtDisplay(options);
  return (
    <>
      <span
        data-composer-thought-label
        className="shrink-0 text-foreground-subtle group-data-[composer-model-icon=true]/toolbar:hidden"
      >
        {label}
      </span>
      <span
        aria-hidden="true"
        data-testid="composer-thought-meter"
        data-progress={progress}
        className="relative hidden h-4 w-1 shrink-0 overflow-hidden rounded-full bg-foreground/10 group-data-[composer-model-icon=true]/toolbar:block"
      >
        <span
          className="absolute bottom-0 left-0 w-full rounded-full bg-foreground-subtle"
          style={{ height: `${progress}%` }}
        />
      </span>
    </>
  );
}

function EffortHeading({
  label,
  value,
  shortcut,
}: {
  label: string;
  value: string;
  shortcut?: string;
}) {
  return (
    <div className="mb-1 flex min-w-0 items-center gap-2 text-ui-base">
      <span className="text-ui-sm text-foreground-subtle">{label}</span>
      <span data-testid="composer-thought-value" className="min-w-0">
        <RollingToolbarLabel label={value} />
      </span>
      {shortcut ? (
        <Kbd className="ml-auto" data-testid="composer-effort-shortcut">
          {shortcut}
        </Kbd>
      ) : null}
    </div>
  );
}

/** 统一菜单只是原模型/档位 owner 的受控展示，不保留第二份选择元组。 */
export function ComposerModelMenu({
  groups,
  normalizedValue,
  options,
  renderItems,
  providerFooter,
  isItemLocked,
  onSelectModel,
}: {
  groups: readonly ModelSelectGroup[];
  normalizedValue: string;
  options: ComposerModelOptions;
  renderItems: (items: ModelSelectGroup["items"]) => ReactNode;
  providerFooter?: ReactNode;
  isItemLocked: (value: string) => boolean;
  onSelectModel: (value: string) => void;
}) {
  const [browse, setBrowse] = useState<{ key: string; selection: string } | null>(null);
  const selected = groups.find((group) =>
    group.items.some((item) => item.value === normalizedValue),
  );
  const group =
    (browse?.selection === normalizedValue
      ? groups.find((entry) => entry.key === browse.key)
      : undefined) ??
    selected ??
    groups[0];
  const groupSelected = Boolean(selected && group?.key === selected.key);
  const currentIndex = options.levels.findIndex((level) => level.value === options.value);
  const { label } = getComposerThoughtDisplay(options);
  const sliderRef = useRef<HTMLInputElement>(null);
  const sliderDisabled = Boolean(options.pending) || !groupSelected || options.levels.length < 2;
  const selectSliderValue = (index: number) => {
    const level = options.levels[index];
    if (!sliderDisabled && level && level.value !== options.value)
      options.onValueChange(level.value);
  };

  return (
    <ComposerProviderMenu
      groups={groups}
      group={group}
      selectedKey={selected?.key}
      label={options.providerLabel}
      pending={options.pending}
      providerFooter={providerFooter}
      onSelect={(candidate) => {
        setBrowse({ key: candidate.key, selection: normalizedValue });
        const model =
          candidate.items.find(
            (item) => item.value === normalizedValue && !isItemLocked(item.value),
          ) ?? candidate.items.find((item) => !isItemLocked(item.value));
        if (model && model.value !== normalizedValue) onSelectModel(model.value);
      }}
    >
      <DropdownMenuSeparator className="shrink-0" />
      <DropdownMenuLabel className="shrink-0 text-ui-sm text-foreground-subtle">
        {options.modelsLabel}
      </DropdownMenuLabel>
      <ScrollFadeViewport
        className="max-h-60 flex-initial"
        inert={options.pending || undefined}
        data-composer-model-list
      >
        {group ? renderItems(group.items) : null}
      </ScrollFadeViewport>
      {options.levels.length > 0 ? (
        <>
          <DropdownMenuSeparator className="shrink-0" />
          {options.levels.length === 1 ? (
            <div className="shrink-0 px-2 py-2">
              <EffortHeading label={options.effortLabel} value={groupSelected ? label : "—"} />
            </div>
          ) : (
            <DropdownMenuItem
              className="block shrink-0 px-2 py-2 focus:bg-transparent"
              aria-disabled={sliderDisabled}
              onSelect={(event) => event.preventDefault()}
              onFocus={(event) => {
                if (event.target === event.currentTarget) sliderRef.current?.focus();
              }}
            >
              <EffortHeading
                label={options.effortLabel}
                value={groupSelected ? label : "—"}
                shortcut={options.effortShortcutLabel}
              />
              <input
                ref={sliderRef}
                type="range"
                min={0}
                max={options.levels.length - 1}
                step={1}
                value={Math.max(0, currentIndex)}
                aria-disabled={sliderDisabled}
                aria-label={options.effortLabel}
                aria-valuetext={groupSelected ? label : "—"}
                data-testid="composer-thought-slider"
                data-levels={JSON.stringify(options.levels.map((level) => level.value))}
                className="block h-8 w-full cursor-pointer accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-default"
                onPointerDown={(event) => {
                  // 不能 stopPropagation：Radix 的内部点击标记残留会让第一次外侧点击不关闭菜单。
                  if (sliderDisabled) event.preventDefault();
                }}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") {
                    event.stopPropagation();
                    if (sliderDisabled && event.key !== "Tab") event.preventDefault();
                  }
                }}
                onKeyUp={(event) => {
                  // 空档位的 range 物理位置仍为 0；Home 不触发 change，只在明确手势完成时接纳。
                  if (
                    [
                      "Home",
                      "End",
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                      "PageUp",
                      "PageDown",
                    ].includes(event.key)
                  ) {
                    selectSliderValue(Number(event.currentTarget.value));
                  }
                }}
                onPointerUp={(event) => selectSliderValue(Number(event.currentTarget.value))}
                onChange={(event) => selectSliderValue(Number(event.currentTarget.value))}
              />
            </DropdownMenuItem>
          )}
        </>
      ) : null}
    </ComposerProviderMenu>
  );
}
