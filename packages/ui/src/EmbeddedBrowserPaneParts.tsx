import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  ExternalLink,
  FileDown,
  ImageDown,
  MonitorSmartphone,
  MousePointerClick,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_BACK_BUTTON,
  TID_BROWSER_DEVTOOLS_BUTTON,
  TID_BROWSER_ELEMENT_PICKER_BUTTON,
  TID_BROWSER_EXPORT_PDF_ITEM,
  TID_BROWSER_EXPORT_PNG_ITEM,
  TID_BROWSER_SITE_SETTINGS_ITEM,
  TID_BROWSER_FORWARD_BUTTON,
  TID_BROWSER_MORE_BUTTON,
  TID_BROWSER_OPEN_EXTERNAL_ITEM,
  TID_BROWSER_REFRESH_BUTTON,
  TID_BROWSER_RESPONSIVE_BUTTON,
} from "@zcode/shared/test-ids";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Input } from "@/components/ui/input.js";
import { isDefaultBrowserOpenableUrl, type BrowserState } from "@/embeddedBrowserHelpers.js";
export {
  BrowserEmptyState,
  BrowserLoadErrorState,
  BrowserGuestFailureState,
} from "./EmbeddedBrowserStates.js";

export function BrowserToolbar({
  addressValue,
  browserState,
  permissionControl,
  formatMessage,
  onAddressChange,
  onGoBack,
  onGoForward,
  onOpenExternal,
  onOpenDevTools,
  onPickElement,
  onReload,
  onToggleResponsiveMode,
  onSubmit,
  isElementPickerActive,
  isResponsiveMode,
  canExport = false,
  isExporting = false,
  onExportPdf,
  onExportPng,
  onOpenSiteSettings,
}: {
  addressValue: string;
  browserState: BrowserState;
  /** 地址栏左侧的站点设置入口；聚焦编辑 URL 时隐藏但不卸载。 */
  permissionControl?: ReactNode;
  formatMessage: (descriptor: { id: string }) => string;
  onAddressChange: (value: string) => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenExternal: () => void;
  onOpenDevTools: () => void;
  onPickElement: () => void;
  onReload: () => void;
  onToggleResponsiveMode: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isElementPickerActive: boolean;
  isResponsiveMode: boolean;
  /** 导出 PNG / PDF 的可用条件；未提供导出回调时菜单不出现这两项。 */
  canExport?: boolean;
  isExporting?: boolean;
  onExportPdf?: () => void;
  onExportPng?: () => void;
  /**
   * 站点设置（与 permissionControl 同一个回调）。窄面板里地址栏隐藏了 permissionControl，
   * 这时由「更多」菜单提供同一入口；宽面板地址栏里有，菜单不重复。不传时没有这一项。
   */
  onOpenSiteSettings?: () => void;
}) {
  const addressBarRef = useRef<HTMLDivElement>(null);
  const isAddressCompact = useIsAddressBarCompact(addressBarRef);
  return (
    <form onSubmit={(event) => onSubmit(event)} className="flex items-center h-12 px-3 gap-2">
      <BrowserIconButton
        icon={<ChevronLeft className="h-4 w-4" />}
        title={formatMessage({ id: "browser.back" })}
        disabled={!browserState.canGoBack}
        dataTestId={TID_BROWSER_BACK_BUTTON}
        onClick={onGoBack}
      />
      <BrowserIconButton
        icon={<ChevronRight className="h-4 w-4" />}
        title={formatMessage({ id: "browser.forward" })}
        disabled={!browserState.canGoForward}
        dataTestId={TID_BROWSER_FORWARD_BUTTON}
        onClick={onGoForward}
      />
      <BrowserIconButton
        icon={<RefreshCw className={`h-4 w-4 ${browserState.isLoading ? "animate-spin" : ""}`} />}
        title={formatMessage({ id: "browser.reload" })}
        disabled={!browserState.isReady}
        dataTestId={TID_BROWSER_REFRESH_BUTTON}
        onClick={onReload}
      />
      {/*
        Bugfix（既有问题，BU-E2E-023 窄面板断言）：失焦时输入框固定 px-14（左右共 112px）居中显示 URL，
        border-box 的输入框宽度不能小于内边距；右侧面板很窄（如 Windows 1280 屏 150% 缩放，面板约 260px）时
        外层被压到约 20px，输入框仍是 ~114px，溢出盖住自由尺寸 / 选元素 / 更多三个按钮，点不到。
        按地址栏自身宽度（容器查询）决定内边距：够宽才用 px-14 居中，窄时用小内边距并隐藏站点设置入口，
        输入框不再溢出外层；隐藏的站点设置入口改由「更多」菜单提供（useIsAddressBarCompact）。
      */}
      <div
        ref={addressBarRef}
        className="group/browser-address @container/browser-address relative min-w-0 flex-1"
        data-testid="browser-address-bar"
      >
        <Input
          type="text"
          value={addressValue}
          data-testid={TID_BROWSER_ADDRESS_INPUT}
          size="sm"
          className="h-8 min-w-0 rounded-full px-2 text-left @min-[9rem]/browser-address:px-3 @min-[9rem]/browser-address:not-focus:px-14 @min-[9rem]/browser-address:not-focus:text-center"
          onChange={(event) => onAddressChange(event.target.value)}
          placeholder={formatMessage({ id: "browser.addressPlaceholder" })}
          spellCheck={false}
        />
        {/* 编辑 URL 时隐藏入口但不卸载，避免将隐藏图标误当成关闭权限申请。 */}
        <div className="absolute top-1/2 left-0.5 -translate-y-1/2 group-has-[input:focus]/browser-address:hidden @max-[9rem]/browser-address:hidden">
          {permissionControl}
        </div>
      </div>
      <BrowserIconButton
        icon={<MonitorSmartphone className="h-4 w-4" />}
        title={formatMessage({
          id: isResponsiveMode ? "browser.responsive.exit" : "browser.responsive.enter",
        })}
        disabled={false}
        dataTestId={TID_BROWSER_RESPONSIVE_BUTTON}
        onClick={onToggleResponsiveMode}
        active={isResponsiveMode}
        pressed={isResponsiveMode}
      />
      <BrowserIconButton
        icon={<MousePointerClick className="h-4 w-4" />}
        title={formatMessage({
          id: isElementPickerActive
            ? "browser.elementPicker.cancel"
            : "browser.elementPicker.start",
        })}
        disabled={!browserState.isReady}
        dataTestId={TID_BROWSER_ELEMENT_PICKER_BUTTON}
        onClick={onPickElement}
        active={isElementPickerActive}
        pressed={isElementPickerActive}
      />
      <BrowserToolbarMoreMenu
        canOpenExternal={
          browserState.isReady && isDefaultBrowserOpenableUrl(browserState.currentUrl)
        }
        canOpenDevTools={browserState.isReady}
        formatMessage={formatMessage}
        onOpenExternal={onOpenExternal}
        onOpenDevTools={onOpenDevTools}
        canExport={canExport && !isExporting}
        onExportPdf={onExportPdf}
        onExportPng={onExportPng}
        onOpenSiteSettings={isAddressCompact ? onOpenSiteSettings : undefined}
      />
    </form>
  );
}

/**
 * 地址栏窄到隐藏站点设置入口时为 true。阈值与地址栏上的容器查询 `@min-[9rem]/browser-address` 同一个值：
 * 菜单内容渲染在 portal 里，容器查询够不着，所以这里量地址栏宽度决定菜单项。
 */
const ADDRESS_BAR_COMPACT_REM = 9;

function useIsAddressBarCompact(ref: RefObject<HTMLDivElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const rootFontSize = () =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const update = () =>
      setCompact(element.getBoundingClientRect().width < ADDRESS_BAR_COMPACT_REM * rootFontSize());
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return compact;
}

function BrowserToolbarMoreMenu({
  canExport,
  canOpenDevTools,
  canOpenExternal,
  formatMessage,
  onExportPdf,
  onExportPng,
  onOpenDevTools,
  onOpenExternal,
  onOpenSiteSettings,
}: {
  onOpenSiteSettings?: () => void;
  canExport: boolean;
  canOpenDevTools: boolean;
  canOpenExternal: boolean;
  formatMessage: (descriptor: { id: string }) => string;
  onExportPdf?: () => void;
  onExportPng?: () => void;
  onOpenDevTools: () => void;
  onOpenExternal: () => void;
}) {
  const moreLabel = formatMessage({ id: "browser.more" });
  return (
    <DropdownMenu>
      <ControlHintTooltip title={moreLabel}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={moreLabel}
            data-testid={TID_BROWSER_MORE_BUTTON}
          >
            <Ellipsis className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      {/*
        Bugfix：选完菜单项马上再点「更多」打不开（Windows 1 倍 BU-E2E-023 导出 PDF 找不到菜单项）。
        关闭时内容要播 100ms 退出动画才卸载，这期间旧菜单的 DismissableLayer 仍在监听「点外部」；
        点触发器先打开新菜单，又被旧层当成点外部当场关掉。关闭时不播退出动画、立即卸载，就没有这段窗口。
        kit 里的 data-closed:animate-out 与这里的类 cn 不会去重、且排在后面，所以要加 ! 才压得住。
      */}
      <DropdownMenuContent align="end" className="w-52 data-closed:animate-none!">
        <DropdownMenuItem
          data-testid={TID_BROWSER_OPEN_EXTERNAL_ITEM}
          disabled={!canOpenExternal}
          onSelect={onOpenExternal}
        >
          <ExternalLink className="size-4" />
          <span>{formatMessage({ id: "browser.openExternal" })}</span>
        </DropdownMenuItem>
        {onExportPng ? (
          <DropdownMenuItem
            data-testid={TID_BROWSER_EXPORT_PNG_ITEM}
            disabled={!canExport}
            onSelect={onExportPng}
          >
            <ImageDown className="size-4" />
            <span>{formatMessage({ id: "browser.export.png" })}</span>
          </DropdownMenuItem>
        ) : null}
        {onExportPdf ? (
          <DropdownMenuItem
            data-testid={TID_BROWSER_EXPORT_PDF_ITEM}
            disabled={!canExport}
            onSelect={onExportPdf}
          >
            <FileDown className="size-4" />
            <span>{formatMessage({ id: "browser.export.pdf" })}</span>
          </DropdownMenuItem>
        ) : null}
        {onOpenSiteSettings ? (
          <DropdownMenuItem
            data-testid={TID_BROWSER_SITE_SETTINGS_ITEM}
            onSelect={onOpenSiteSettings}
          >
            <SlidersHorizontal className="size-4" />
            <span>{formatMessage({ id: "browser.permission.settings" })}</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          data-testid={TID_BROWSER_DEVTOOLS_BUTTON}
          disabled={!canOpenDevTools}
          onSelect={onOpenDevTools}
        >
          <Bug className="size-4" />
          <span>{formatMessage({ id: "browser.devtools" })}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BrowserIconButton({
  dataTestId,
  disabled,
  icon,
  onClick,
  title,
  active = false,
  pressed,
}: {
  dataTestId: string;
  disabled: boolean;
  icon: ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  pressed?: boolean;
}) {
  return (
    <ControlHintTooltip title={title}>
      <Button
        type="button"
        size="icon-md"
        variant="ghost"
        // 灰色选中态不易与普通悬停区分；两个模式开关统一用主题蓝色，并在悬停时保留。
        className={
          active ? "bg-accent text-icon-blue hover:bg-accent hover:text-icon-blue" : undefined
        }
        aria-label={title}
        aria-pressed={pressed}
        data-testid={dataTestId}
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
      </Button>
    </ControlHintTooltip>
  );
}
