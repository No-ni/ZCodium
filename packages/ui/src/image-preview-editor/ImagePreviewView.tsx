import { MinusIcon, PlusIcon, PencilIcon, ChevronRightIcon, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog.js";
import type { ImagePreviewSurfaceProps } from "@/image-preview-editor/contract.js";
import { AnnotationLayer } from "@/image-preview-editor/annotations.js";
import { ImagePreviewActions } from "@/image-preview-editor/ImagePreviewActions.js";
import { ImageEditorToolbar } from "@/image-preview-editor/ImageEditorToolbar.js";
import { ImageTextDraftEditor } from "@/image-preview-editor/ImagePreviewControls.js";
import type { useImagePreviewController } from "./useImagePreviewController.js";
export function ImagePreviewView({
  model,
  src,
  alt,
  filename,
  imageTestId,
  onDownload,
  downloading,
  onSaved,
  onClose,
}: ImagePreviewSurfaceProps & { model: ReturnType<typeof useImagePreviewController> }) {
  const {
    intl,
    keepEditingRef,
    actionPending,
    actionBusy,
    setActionBusy,
    pendingExit,
    setPendingExit,
    editing,
    setEditing,
    viewportRef,
    surfaceRef,
    imageRef,
    overlayRef,
    addButtonRef,
    addPosition,
    natural,
    setNatural,
    transform,
    setTransform,
    tool,
    setTool,
    color,
    setColor,
    history,
    selected,
    setSelected,
    textDraft,
    setTextDraft,
    saving,
    size,
    cursor,
    displayed,
    commit,
    undo,
    redo,
    zoom,
    pointerDown,
    pointerMove,
    pointerEnd,
    dirty,
    save,
  } = model;
  const ZERO = { x: 0, y: 0 };

  return (
    <>
      <ImagePreviewActions
        src={src}
        alt={alt}
        filename={filename}
        imageRef={imageRef}
        ready={!saving && natural.width > 0}
        onAdded={onSaved}
        onBusyChange={(busy) => {
          actionPending.current = busy;
          setActionBusy(busy);
        }}
        onAddEdited={dirty ? () => void save() : undefined}
        onDownload={onDownload}
        downloading={downloading}
        zoomControls={
          <>
            <Button
              aria-label={intl.formatMessage({ id: "markdownImage.zoomOut" })}
              disabled={actionBusy || saving || transform.scale <= 0.5}
              onClick={() => zoom(transform.scale - 0.5)}
              size="icon-sm"
              variant="ghost"
              className="rounded-full"
            >
              <MinusIcon />
            </Button>
            <button
              type="button"
              title={intl.formatMessage({ id: "preview.image.resetZoom" })}
              onClick={() => setTransform({ scale: 1, offset: ZERO })}
              className="min-w-10 text-center text-ui-sm"
            >
              {Math.round(transform.scale * 100)}%
            </button>
            <Button
              aria-label={intl.formatMessage({ id: "markdownImage.zoomIn" })}
              disabled={actionBusy || saving || transform.scale >= 3}
              onClick={() => zoom(transform.scale + 0.5)}
              size="icon-sm"
              variant="ghost"
              className="rounded-full"
            >
              <PlusIcon />
            </Button>
          </>
        }
      >
        <div
          tabIndex={0}
          aria-label={alt}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
              }),
            );
          }}
          className="absolute inset-x-14 bottom-24 top-20 overflow-hidden sm:inset-x-16"
          data-image-preview-viewport=""
          ref={viewportRef}
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <div
            data-image-preview-surface=""
            ref={surfaceRef}
            className="absolute left-1/2 top-1/2 touch-none select-none"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerEnd}
            onPointerCancel={pointerEnd}
            onLostPointerCapture={pointerEnd}
            style={{
              width: size.width,
              height: size.height,
              cursor,
              transform: `translate(-50%, -50%) translate(${transform.offset.x}px, ${transform.offset.y}px) scale(${transform.scale})`,
            }}
          >
            <img
              alt={alt}
              src={src}
              ref={imageRef}
              data-testid={imageTestId}
              draggable={false}
              className="size-full rounded-xl object-contain"
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
            <svg
              ref={overlayRef}
              className={`pointer-events-none absolute inset-0 size-full overflow-hidden text-foreground ${editing ? "" : "[&_*]:pointer-events-none!"}`}
              viewBox={`0 0 ${natural.width || 1} ${natural.height || 1}`}
              xmlns="http://www.w3.org/2000/svg"
            >
              <AnnotationLayer annotations={displayed} selected={selected} />
            </svg>
          </div>
        </div>
      </ImagePreviewActions>
      {textDraft ? (
        <ImageTextDraftEditor
          value={textDraft.text}
          disabled={actionBusy || saving}
          onChange={(text) => setTextDraft({ ...textDraft, text })}
          onSubmit={() => {
            if (textDraft.text?.trim()) commit([...history.present, textDraft]);
            setTextDraft(null);
          }}
          onCancel={() => setTextDraft(null)}
        />
      ) : null}
      {/* 侧边轨道预留图片外边距，收起只保留小入口；窄屏竖向滚动不遮挡顶部操作。 */}
      <div
        data-image-preview-drawing-rail=""
        className="absolute top-1/2 z-20 flex max-h-[calc(100%-10rem)] -translate-y-1/2 flex-col items-center gap-1 rounded-xl border border-popover-border bg-popover p-1 shadow-md"
        style={{ right: `max(0.5rem, calc(50% - ${size.width / 2}px - 3.25rem))` }}
      >
        <div className="shrink-0">
          <Button
            variant="ghost"
            size="icon-lg"
            title={intl.formatMessage({ id: "preview.image.annotate" })}
            aria-label={intl.formatMessage({ id: "preview.image.annotate" })}
            aria-expanded={editing}
            data-image-preview-annotate=""
            aria-pressed={editing}
            disabled={actionBusy || saving}
            onClick={() => {
              setEditing(!editing);
              setTool("select");
              setSelected(null);
              if (textDraft?.text?.trim()) commit([...history.present, textDraft]);
              setTextDraft(null);
            }}
          >
            {editing ? <ChevronRightIcon /> : <PencilIcon />}
          </Button>
        </div>
        {editing ? (
          <ImageEditorToolbar
            tool={tool}
            onTool={(value) => {
              setTool(value);
              setSelected(null);
              if (textDraft?.text?.trim()) commit([...history.present, textDraft]);
              setTextDraft(null);
            }}
            color={color}
            onColor={setColor}
            undo={undo}
            redo={redo}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            disabled={actionBusy || saving || !natural.width}
          />
        ) : null}
      </div>
      {dirty ? (
        <div
          className="absolute z-20 -translate-x-1/2"
          style={{ ...addPosition, visibility: addPosition ? "visible" : "hidden" }}
        >
          <Button
            ref={addButtonRef}
            data-image-preview-save=""
            variant="outline"
            size="lg"
            className="h-9 gap-2 whitespace-nowrap rounded-lg border-popover-border bg-popover px-4 text-ui-base font-medium text-foreground shadow-md hover:bg-menu-hover"
            disabled={actionBusy || saving}
            onClick={() => void save()}
          >
            <MessageSquarePlus className="size-4" />
            {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
          </Button>
        </div>
      ) : null}
      <AlertDialog
        open={Boolean(pendingExit)}
        onOpenChange={(open) => {
          if (!open && !saving) setPendingExit(null);
        }}
      >
        <AlertDialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            keepEditingRef.current?.focus();
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            if (!saving) setPendingExit(null);
          }}
        >
          <AlertDialogTitle>
            {intl.formatMessage({ id: "imageEditor.unsavedTitle" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "imageEditor.unsavedDescription" })}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button
              ref={keepEditingRef}
              variant="ghost"
              disabled={saving}
              onClick={() => setPendingExit(null)}
            >
              {intl.formatMessage({ id: "imageEditor.keepEditing" })}
            </Button>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => {
                const proceed = pendingExit;
                setPendingExit(null);
                proceed?.();
              }}
            >
              {intl.formatMessage({ id: "imageEditor.discard" })}
            </Button>
            <Button disabled={saving} onClick={() => void save()}>
              {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
