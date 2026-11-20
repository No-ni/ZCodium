import type { ImagePreviewSurfaceProps } from "./contract.js";
import { useImagePreviewController } from "./useImagePreviewController.js";
import { ImagePreviewView } from "./ImagePreviewView.js";
export function ImagePreviewSurface(props: ImagePreviewSurfaceProps) {
  const model = useImagePreviewController(props);
  return <ImagePreviewView {...props} model={model} />;
}
