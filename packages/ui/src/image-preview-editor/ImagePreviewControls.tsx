import { MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
// 图片预览浮层控件的展示层：文本草稿的值、标注历史与提交/保存仍由 ImagePreviewSurface 唯一持有，这里只做渲染与事件回传。
export function ImageTextDraftEditor({
  value,
  disabled,
  onChange,
  onSubmit,
  onCancel,
}: {
  value?: string;
  disabled: boolean;
  onChange: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="absolute left-1/2 top-20 z-30 flex max-w-full -translate-x-1/2 gap-1 rounded-xl border border-popover-border bg-popover p-2"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Input
        autoFocus
        aria-label={intl.formatMessage({ id: "imageEditor.textValue" })}
        value={value}
        disabled={disabled}
        className="w-48 text-mobile-input-safe sm:text-ui-base"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // 输入法组合态的 Enter 只确认候选词，不能当成提交；沿用拆分前的判断顺序。
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSubmit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <Button onClick={onSubmit} disabled={disabled}>
        {intl.formatMessage({ id: "imageEditor.applyText" })}
      </Button>
    </div>
  );
}
export function ImageSaveControl({
  saving,
  disabled,
  onSave,
}: {
  saving: boolean;
  disabled: boolean;
  onSave: () => void;
}) {
  const { intl } = useZCodeIntl();
  // 禁用按钮不接收指针事件，用容器接住点击，避免穿透到遮罩而关闭预览。
  return (
    <div className="absolute left-4 top-4 z-20 platform-mac-desktop:top-12 platform-windows-desktop:top-[calc(env(titlebar-area-height,48px)_+_0.5rem)]">
      <Button data-image-preview-save="" disabled={disabled} onClick={onSave}>
        {intl.formatMessage({ id: saving ? "imageEditor.saving" : "imageEditor.save" })}
      </Button>
    </div>
  );
}
export function ImageZoomControls({
  scale,
  disabled,
  onZoom,
}: {
  scale: number;
  disabled: boolean;
  onZoom: (scale: number) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-popover-border bg-popover p-1 shadow-md">
      <Button
        aria-label={intl.formatMessage({ id: "markdownImage.zoomOut" })}
        disabled={disabled || scale <= 0.5}
        onClick={() => onZoom(scale - 0.5)}
        size="icon-sm"
        variant="ghost"
        className="rounded-full"
      >
        <MinusIcon />
      </Button>
      <span className="min-w-12 text-center text-ui-base">{Math.round(scale * 100)}%</span>
      <Button
        aria-label={intl.formatMessage({ id: "markdownImage.zoomIn" })}
        disabled={disabled || scale >= 3}
        onClick={() => onZoom(scale + 0.5)}
        size="icon-sm"
        variant="ghost"
        className="rounded-full"
      >
        <PlusIcon />
      </Button>
    </div>
  );
}
