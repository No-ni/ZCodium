import { useEffect, type RefObject } from "react";
import { OfficeError } from "#office/contract.ts";
import { formatAnchor, splitAnchor } from "#office/domain/anchor.ts";
import { getHost } from "#ui/host.ts";
import { call } from "#ui/rpc.ts";
import { parseCaptureInput } from "#ui/captureInput.ts";
import type { LoadedDoc } from "#ui/shell/state.ts";
import type { ViewerHandle } from "#ui/viewers/types.ts";

/** 真正渲染的页面截图；无就绪查看器时显式失败，关闭/切换代次与取消不返回旧截图。 */
export function useCaptureView(
  docRef: RefObject<LoadedDoc | null>,
  viewer: RefObject<ViewerHandle | null>,
  ready: RefObject<boolean>,
  generation: RefObject<number>,
) {
  useEffect(() => {
    return getHost().handleTool("capture_view", async (raw, signal) => {
      const input = parseCaptureInput(raw);
      const current = docRef.current;
      const handle = viewer.current;
      if (!current || !handle) throw new OfficeError("no_document", "Call open_document first.");
      if (!ready.current) throw new OfficeError("panel_loading", "Document not rendered yet.");
      const mine = generation.current;
      const check = () => {
        if (signal?.aborted) throw new OfficeError("cancelled", "Capture cancelled.");
        if (
          generation.current !== mine ||
          docRef.current !== current ||
          viewer.current !== handle ||
          !ready.current
        )
          throw new OfficeError("invalid_token", "The viewer generation changed.");
      };
      check();
      let at: string | null = null;
      if (input.anchor) {
        const split = splitAnchor(input.anchor);
        if (split.path.replace(/^\.\//, "") !== current.info.path)
          throw new OfficeError("invalid_anchor", "The capture must address the open document.");
        // parser 是真实锚点边界 owner；shape/range 截图不能只验第一页/第一格。
        const checked = await call<{ at: string | null }>("check_document", {
          path: split.path,
          at: split.at ?? undefined,
        });
        at = checked.at;
      }
      check();
      const shot = await handle.capture(at, input.maxWidth ?? 1600);
      check();
      return {
        content: [
          { type: "image", data: shot.data, mimeType: "image/png" },
          {
            type: "text",
            text: `Captured ${formatAnchor(current.info.path, shot.at)} (${shot.width}×${shot.height} px).`,
          },
        ],
      };
    });
  }, [docRef, viewer, ready, generation]);
}
