import { useCallback, useEffect, useRef, useState } from "react";
import type { IZCodeAgentService } from "@zcode/services";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import {
  ConversationMarkdownError,
  readConversationMarkdown,
  type ConversationMarkdownTarget,
} from "@/lib/readConversationMarkdown.js";

export function useCopyConversationMarkdown(
  agent: Pick<IZCodeAgentService, "conversationRowsRangeV4">,
  target: Omit<ConversationMarkdownTarget, "sessionId"> & { sessionId: string | null },
) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const copy = useCallback(async () => {
    if (busy.current || !target.sessionId || !platform.writeClipboardText) return;
    busy.current = true;
    setPending(true);
    const content = readConversationMarkdown((input) => agent.conversationRowsRangeV4(input), {
      ...target,
      sessionId: target.sessionId,
    });
    try {
      // 同步提交剪贴板写入；两条 Promise 全部结束后才释放单飞状态。
      const [read, written] = await Promise.allSettled([
        content,
        platform.writeClipboardText(content),
      ]);
      if (read.status === "rejected") throw read.reason;
      if (written.status === "rejected") throw written.reason;
      toast(intl.formatMessage({ id: "appHeader.copyMarkdownSucceeded" }));
      logger.info("[copyConversationMarkdown] 会话已复制为 Markdown");
    } catch (error) {
      await content.catch(() => undefined);
      const code = error instanceof ConversationMarkdownError ? error.code : "failed";
      const id =
        code === "changed"
          ? "appHeader.copyMarkdownChanged"
          : code === "empty"
            ? "appHeader.copyMarkdownEmpty"
            : code === "limit"
              ? "appHeader.copyMarkdownTooLarge"
              : "appHeader.copyMarkdownFailed";
      toast(intl.formatMessage({ id }));
      logger.warn("[copyConversationMarkdown] 复制失败", { code });
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }, [agent, target, platform, intl]);
  return { copy, pending, available: Boolean(target.sessionId && platform.writeClipboardText) };
}
