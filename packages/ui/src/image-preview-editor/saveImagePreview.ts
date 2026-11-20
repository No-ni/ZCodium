import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { captureImageComposerTarget } from "./composerTarget.js";
import { exportAnnotatedImage } from "./annotations.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
/** 保存仍使用原预览实例的 pending/alive 与同一次捕获的 Composer target。 */
export async function saveImagePreview({
  image,
  overlay,
  filename,
  pending,
  alive,
  setSaving,
  intl,
  onSaved,
}: {
  image: HTMLImageElement | null;
  overlay: SVGSVGElement | null;
  filename: string;
  pending: { current: boolean };
  alive: { current: boolean };
  setSaving: (value: boolean) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onSaved: () => void;
}) {
  if (pending.current || !image || !overlay) return;
  const target = captureImageComposerTarget();
  if (!target) {
    toast(intl.formatMessage({ id: "imageEditor.noComposer" }));
    return;
  }
  pending.current = true;
  setSaving(true);
  try {
    const file = await exportAnnotatedImage(image, overlay, filename);
    if (!alive.current) return;
    if (!target.append(file)) throw new Error("Composer rejected the image");
    toast(intl.formatMessage({ id: "imageEditor.addedToChat" }));
    onSaved();
  } catch {
    if (!alive.current) return;
    logger.warn("[ImagePreviewDialog] 标注图片保存失败", { event: "image_save_failed" });
    toast(intl.formatMessage({ id: "imageEditor.saveFailed" }));
  } finally {
    pending.current = false;
    if (alive.current) setSaving(false);
  }
}
