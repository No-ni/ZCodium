"use client";

import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/components/lib/utils.js";
import { formatRunningWorkDuration } from "@/lib/workDuration.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConversationWorkDuration } from "@/hooks/useConversationWorkDuration.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import type { ConversationTurnWorkStatus } from "@/v4/conversationTurnWorkSegments.js";

/** 独立刷新浮动输入框文案，避免秒钟触发整个 Composer 与 Lexical 重渲染。 */
export function ConversationWorkingPlaceholder({
  status,
  fallback,
}: {
  status: ConversationTurnWorkStatus | undefined;
  fallback: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const durationMs = useConversationWorkDuration(status);
  const duration = formatConversationWorkDuration(durationMs, intl, locale);
  return duration ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration }) : fallback;
}

export interface ChatLoadingProps extends ComponentPropsWithoutRef<"div"> {
  loading: boolean;
  elapsedMs?: number;
  size?: "default" | "sm";
}

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];

export function ChatLoadingPixels() {
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 size-[13px] grid-cols-3 grid-rows-3 gap-[1.3px] text-foreground"
    >
      {Array.from({ length: 9 }, (_, index) => (
        <span
          key={index}
          className="zcode-loading-pixel size-full rounded-[1px] bg-current"
          style={{
            opacity: index === 4 ? 0.07 : 0.15,
            animationName: index === 4 ? "none" : undefined,
            animationDuration: "950ms",
            animationDelay: `${Math.max(0, ORBIT_ORDER.indexOf(index)) * 110}ms`,
          }}
        />
      ))}
    </span>
  );
}

export function ChatLoading({
  loading,
  elapsedMs,
  className,
  size: _size,
  ...props
}: ChatLoadingProps) {
  const { intl, locale } = useZCodeIntl();
  // 会话切换、交互等待与重试会重挂载反馈；耗时由调用方按权威工作起点派生，不能从挂载时重计。
  if (!loading) return null;
  return (
    <div
      role="status"
      aria-label={intl.formatMessage({ id: "common.loading" })}
      data-zcode-chat-loading-animate="true"
      {...props}
      className={cn("inline-flex w-fit items-center gap-2.5", className)}
    >
      <ChatLoadingPixels />
      <span className="zcode-loading-label text-ui-base font-medium">
        {intl.formatMessage({ id: "chat.loading.working" })}
      </span>
      {elapsedMs !== undefined ? (
        <span
          aria-hidden="true"
          className="font-mono text-ui-caption tabular-nums text-foreground-subtle"
        >
          {formatRunningWorkDuration(
            elapsedMs,
            (descriptor) => intl.formatMessage(descriptor),
            locale,
          )}
        </span>
      ) : null}
    </div>
  );
}
