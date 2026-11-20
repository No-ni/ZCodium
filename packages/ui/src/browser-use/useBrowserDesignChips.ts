import { useCallback, useEffect, useRef, type RefObject } from "react";
import type {
  DesignRuntimeCommand,
  DesignSelectedElement,
  PageElementRect,
} from "@zcode/design-runtime";
import {
  createWebElementContextId,
  dispatchWebElementContextAddToChat,
  dispatchWebElementContextRemoveFromChat,
  subscribeWebElementContextsRemoved,
} from "@/lib/webElementContext.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { DesignChipTarget } from "@/browser-use/browserDesignTarget.js";
import {
  selectorOf,
  withDeadline,
  PAGE_COMMAND_DEADLINE_MS,
  CAPTURE_DEADLINE_MS,
} from "./browserDesignModeHelpers.js";
type ChipOptions = {
  captureElement?: (rect: PageElementRect) => Promise<ArrayBuffer | null>;
  chipTarget: DesignChipTarget | null;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  latest: RefObject<{ selections: readonly DesignSelectedElement[] }>;
  runLatest: (command: DesignRuntimeCommand) => Promise<unknown>;
};
// 每个 tab 的原引用队列在此唯一持有，仍读取原 design owner 的最新选中集合。
export function useBrowserDesignChips({
  captureElement,
  chipTarget,
  intl,
  latest,
  runLatest,
}: ChipOptions) {
  // ---- 选中 → 输入框里的元素引用 ----
  // 选中集合变了就对一次账：取消选中的撤回，新选中的截图后加进去。串行执行，同一元素不会加两次；
  // 截图期间又取消了选中或页面换了文档，就不加（下一次对账按当时的选中再算）。
  const chipsRef = useRef(new Map<string, string>());
  // 没有可接收的输入框时只提示一次：同一轮点选里写回 / 撤销会反复重读选中，不再重复弹（detachChips 时复位）
  const noTargetNotifiedRef = useRef(false);
  const chipQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  // Bugfix（11-05「点中元素不进输入框」）：对账是串行队列，页面导航 / 自动刷新时 webview 的 executeJavaScript
  // 可能永远不返回，卡住的那一步让之后所有选中都进不了输入框。每份新文档（运行时装好）换一代、队列从头开始，
  // 旧任务在每个 await 之后发现代际变了就退出。
  const chipGenerationRef = useRef(0);
  const enqueueChips = useCallback((task: (alive: () => boolean) => Promise<void>) => {
    const generation = chipGenerationRef.current;
    chipQueueRef.current = chipQueueRef.current
      .then(() => task(() => chipGenerationRef.current === generation))
      .catch((error: unknown) => {
        logger.warn("[BrowserDesign] 元素引用对账失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);
  const resetChipQueue = useCallback(() => {
    chipGenerationRef.current += 1;
    chipQueueRef.current = Promise.resolve();
  }, []);
  const captureSelection = useCallback(
    async (selector: string): Promise<ArrayBuffer | null> => {
      if (!captureElement || !selector) return null;
      try {
        const rect = (await runLatest({
          type: "locate-for-capture",
          selector,
        })) as PageElementRect | null;
        if (!rect || rect.width <= 0 || rect.height <= 0) return null;
        return await captureElement(rect);
      } catch (error) {
        // 截图只是附加信息：失败时引用照常只带文字
        logger.warn("[BrowserDesign] 元素截图失败，只附加文字", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        await runLatest({ type: "end-capture" });
      }
    },
    [captureElement, runLatest],
  );
  // 选中变了就当场对账（同步）：取消选中的撤回、新选中的马上以文字引用加进输入框；
  // 截图慢（main 取帧可能要十几秒），放进串行队列，回来后按同一 id 补到那条引用上，引用不等截图（11-05 反馈）。
  const reconcileChips = useCallback(() => {
    // 没有可接收的输入框（没有工作区，或输入框不收引用）：每轮点选只提示一次（!3548 第四、五轮）
    const notifyNoTarget = () => {
      if (noTargetNotifiedRef.current) return;
      noTargetNotifiedRef.current = true;
      toast(intl.formatMessage({ id: "browser.design.contextUnavailable" }), {
        variant: "warning",
        position: "bottom-center",
        dedupeKey: "browser-design-context-unavailable",
      });
    };
    if (!chipTarget) {
      if (latest.current.selections.length > 0) notifyNoTarget();
      return;
    }
    const wanted = new Set(latest.current.selections.map(selectorOf));
    for (const [selector, id] of chipsRef.current) {
      if (wanted.has(selector)) continue;
      dispatchWebElementContextRemoveFromChat({ id, ...chipTarget });
      chipsRef.current.delete(selector);
    }
    let accepted = false;
    let rejected = false;
    for (const selection of latest.current.selections) {
      const selector = selectorOf(selection);
      if (!selector || chipsRef.current.has(selector)) continue;
      const id = createWebElementContextId();
      // inline：在输入框正文里以元素 token 出现（像 Skill 一样能穿插文字）
      const payload = { ...selection.element, id, ...chipTarget, inline: true };
      if (!dispatchWebElementContextAddToChat(payload)) {
        rejected = true;
        notifyNoTarget();
        continue;
      }
      accepted = true;
      chipsRef.current.set(selector, id);
      enqueueChips(async (alive) => {
        const readToken = () =>
          withDeadline(runLatest({ type: "read-document-token" }), PAGE_COMMAND_DEADLINE_MS, null);
        const token = await readToken();
        if (!alive() || chipsRef.current.get(selector) !== id) return;
        const screenshot = await withDeadline(
          captureSelection(selector),
          CAPTURE_DEADLINE_MS,
          null,
        );
        if (!alive() || !screenshot || chipsRef.current.get(selector) !== id) return;
        // 截图期间页面换了文档：截到的可能是另一个页面，不补
        if (typeof token !== "string" || (await readToken()) !== token) return;
        if (!alive() || chipsRef.current.get(selector) !== id) return;
        dispatchWebElementContextAddToChat(
          { ...payload, screenshot: { data: screenshot, mimeType: "image/png" } },
          { updateOnly: true },
        );
      });
    }
    // 这一轮全都收下了才复位：之后再收不下要重新提示；有成有败时不复位，免得下次重读又弹
    // （界面点选每次对账只新增一个元素，「有成有败」是兜底，如恢复多选后输入框只拒其中不合法的一条）
    if (accepted && !rejected) noTargetNotifiedRef.current = false;
  }, [captureSelection, chipTarget, enqueueChips, intl, runLatest]);
  /** 退出点选、换页面：已进输入框的引用留着，只是不再跟着选中变 */
  const detachChips = useCallback(() => {
    chipsRef.current.clear();
    noTargetNotifiedRef.current = false;
  }, []);

  // 输入框里的引用被删掉 / 发出：页面这边同步（输入框与选中保持一致）
  useEffect(() => {
    if (!chipTarget) return;
    return subscribeWebElementContextsRemoved(chipTarget, (ids, reason) => {
      const removed = new Set<string>();
      for (const [selector, id] of chipsRef.current) {
        if (ids.includes(id)) removed.add(selector);
      }
      if (removed.size === 0) return;
      for (const selector of removed) chipsRef.current.delete(selector);
      // 随消息发出：只忘掉引用，选中留着（再点同一元素会重新引用）；用户删掉：页面上一起取消选中
      if (reason !== "user") return;
      const selectors = latest.current.selections
        .map(selectorOf)
        .filter((selector) => !removed.has(selector));
      void runLatest({ type: "set-selection", selectors });
    });
  }, [chipTarget, runLatest]);

  return { reconcileChips, detachChips, resetChipQueue };
}
