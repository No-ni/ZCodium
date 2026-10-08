import { useLayoutEffect } from "react";
import { finishStartupPresentation } from "./startupPresentation.js";

/** 挂在实际内容内部：仅在内容 commit 后退场，首次 React commit 不代表工作区已就绪。 */
export function StartupPresentationReady({ immediate = false }: { immediate?: boolean }) {
  useLayoutEffect(() => finishStartupPresentation(immediate), [immediate]);
  return null;
}
