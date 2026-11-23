/**
 * 草稿态空态问候：时间问候语 + ZCodium Logo。
 * 自旧版 ChatView/ChatViewEmptyState.tsx 恢复（该组件随旧 ChatView 删除，
 * i18n key `chat.empty.greeting.*` 一直保留）；边界时刻自动换档逻辑保真。
 * 手机远控复用同一组件，但继续保留 20px 紧凑标题；桌面草稿首页才按标题自身宽度适配。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { logger } from "@/logger.js";
import { ZCODIUM_WATERMARK_PATH } from "@/v4/zcodiumWatermarkPath.js";

const GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const;
const GREETING_MIN_FONT_SIZE_PX = 20;
const GREETING_MAX_FONT_SIZE_PX = 30;

type ChatEmptyGreetingMessageId =
  | "chat.empty.greeting.morningEarly"
  | "chat.empty.greeting.morning"
  | "chat.empty.greeting.noon"
  | "chat.empty.greeting.afternoon"
  | "chat.empty.greeting.evening"
  | "chat.empty.greeting.lateNight";

function getChatEmptyGreetingMessageId(date: Date = new Date()): ChatEmptyGreetingMessageId {
  const hour = date.getHours();

  if (hour >= 5 && hour < 9) return "chat.empty.greeting.morningEarly";
  if (hour >= 9 && hour < 12) return "chat.empty.greeting.morning";
  if (hour >= 12 && hour < 14) return "chat.empty.greeting.noon";
  if (hour >= 14 && hour < 18) return "chat.empty.greeting.afternoon";
  if (hour >= 18 && hour < 23) return "chat.empty.greeting.evening";

  return "chat.empty.greeting.lateNight";
}

function getNextChatEmptyGreetingDelayMs(date: Date = new Date()) {
  const candidates = GREETING_BOUNDARY_HOURS.map((hour) => {
    const boundary = new Date(date);
    boundary.setHours(hour, 0, 0, 0);
    return boundary;
  });
  const tomorrowFirstBoundary = new Date(date);
  tomorrowFirstBoundary.setDate(tomorrowFirstBoundary.getDate() + 1);
  tomorrowFirstBoundary.setHours(GREETING_BOUNDARY_HOURS[0], 0, 0, 0);

  const nextBoundary =
    candidates.find((candidate) => candidate.getTime() > date.getTime()) ?? tomorrowFirstBoundary;

  return Math.max(1, nextBoundary.getTime() - date.getTime());
}

function resolveGreetingFontSizePx({
  availableWidthPx,
  naturalTextWidthPx,
}: {
  availableWidthPx: number;
  naturalTextWidthPx: number;
}) {
  if (
    !Number.isFinite(availableWidthPx) ||
    !Number.isFinite(naturalTextWidthPx) ||
    availableWidthPx <= 0 ||
    naturalTextWidthPx <= 0 ||
    availableWidthPx >= naturalTextWidthPx
  ) {
    return GREETING_MAX_FONT_SIZE_PX;
  }

  return Math.max(
    GREETING_MIN_FONT_SIZE_PX,
    Math.min(
      GREETING_MAX_FONT_SIZE_PX,
      Math.floor(GREETING_MAX_FONT_SIZE_PX * (availableWidthPx / naturalTextWidthPx)),
    ),
  );
}

export function ConversationDraftEmptyState({
  className,
  compactForRemoteControl = false,
}: {
  className?: string;
  compactForRemoteControl?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const [greetingDate, setGreetingDate] = useState(() => new Date());
  const greetingContainerRef = useRef<HTMLParagraphElement | null>(null);
  const greetingMeasurementRef = useRef<HTMLSpanElement | null>(null);
  const greeting = intl.formatMessage({
    id: isOfficeMode ? "chat.empty.greeting.office" : getChatEmptyGreetingMessageId(greetingDate),
  });

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setGreetingDate(new Date());
    }, getNextChatEmptyGreetingDelayMs(greetingDate));

    return () => {
      window.clearTimeout(timeout);
    };
  }, [greetingDate]);

  useLayoutEffect(() => {
    if (compactForRemoteControl) {
      return;
    }
    const container = greetingContainerRef.current;
    const measurement = greetingMeasurementRef.current;
    if (!container || !measurement) {
      return;
    }

    const measure = () => {
      const containerStyle = window.getComputedStyle(container);
      const horizontalPaddingPx =
        Number.parseFloat(containerStyle.paddingLeft) +
        Number.parseFloat(containerStyle.paddingRight);
      const availableWidthPx = Math.max(
        0,
        container.getBoundingClientRect().width - horizontalPaddingPx,
      );
      const naturalTextWidthPx = measurement.getBoundingClientRect().width;
      const nextFontSizePx = resolveGreetingFontSizePx({ availableWidthPx, naturalTextWidthPx });

      const nextFontSize = `${nextFontSizePx}px`;
      if (container.style.getPropertyValue("--v4-draft-greeting-font-size") === nextFontSize) {
        return;
      }
      // Bugfix：侧栏收窄时，RO → RAF → React state 会先画出旧字号的两行标题，
      // 把输入框推下再弹回。字号只属于 DOM 投影，必须在本次绘制前直接适配。
      container.style.setProperty("--v4-draft-greeting-font-size", nextFontSize);
      logger.debug("[v4-draft-greeting] 标题自身可用宽度变化，更新字号", {
        availableWidthPx: Math.round(availableWidthPx),
        naturalTextWidthPx: Math.round(naturalTextWidthPx),
        nextFontSizePx,
      });
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        window.removeEventListener("resize", measure);
      };
    }

    // 标题字号曾直接绑定整个视口宽度，最小窗口里文字两侧仍有大量空间却被
    // 强制缩到 20px。分别观察标题容器和 30px 原始文案，只在两者真实相撞时缩小。
    const observer = new ResizeObserver(measure);
    // 可见标题的高度会随字号改变；观察它会让同步适配反过来触发 RO 循环。
    // 隐藏测量区字号固定，分别提供可用宽度和原始文案宽度，不受适配结果影响。
    observer.observe(measurement.parentElement!);
    observer.observe(measurement);
    return () => {
      observer.disconnect();
    };
    // 紧凑模式切换要释放旧测量订阅，返回普通模式时重新建立。
  }, [greeting, compactForRemoteControl]);

  return (
    <div
      className={cn(
        "relative mb-10 flex w-full max-w-2xl flex-col items-center justify-center gap-6 text-foreground sm:mb-8",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 aspect-[5/4] w-[min(72vw,25rem)] -mt-10 -translate-x-1/2 -translate-y-1/2 text-foreground-subtlest",
        )}
      >
        <ZCodeEmptyStateLogo className="h-full w-full" />
      </div>
      <p
        ref={greetingContainerRef}
        data-v4-draft-greeting="true"
        className={cn(
          "relative z-10 w-full px-4 text-center font-medium text-foreground",
          compactForRemoteControl
            ? "text-xl/[1.2]"
            : "text-[length:var(--v4-draft-greeting-font-size,30px)]/[1.2]",
        )}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none invisible absolute inset-x-4 whitespace-nowrap text-3xl/[1.2]"
        >
          <span ref={greetingMeasurementRef} className="inline-block">
            {greeting}
          </span>
        </span>
        <span>{greeting}</span>
      </p>
    </div>
  );
}

function ZCodeEmptyStateLogo({ className }: { className?: string }) {
  // 沿用官方浅色主题那版的手法：内联矢量 + currentColor，由 DOM 同步绘制。
  // 不能改回位图蒙版——`mask-image` 指向 PNG 时，元素光栅化若早于图片解码完成，
  // Chromium 只画出当时已就绪的那一段轮廓，水印会缺掉半截并一直留到下次重绘。
  // 轮廓取自珊瑚单色 alpha 资产（public/logo/watermark.png）；应用图标是黑底 +
  // 白珊瑚的双色设计，整体压到 14% 透明度时白珊瑚会先消失，只剩一块灰方块，
  // 所以水印只用轮廓并跟随主题前景色。viewBox 与原资产同构，contain 由
  // preserveAspectRatio 默认值负责，水印的大小与位置和位图版完全一致。
  //
  // 底端渐隐：珊瑚墨迹底边比 composer 卡片顶边低约 5px（标题字号变化时 3~11px），
  // 而卡片只是 3% 的染色（bg-surface 带 alpha）、阴影还会从卡片顶边往上溢约 3px，
  // 否则那一小段珊瑚会画进输入框的染色/阴影里。渐隐到 78% 处全透明，比阴影带上沿
  // 还高约 9px；官方浅色那版 logo 也有同样的底端渐隐，rebrand 成珊瑚时漏掉了。
  return (
    <svg
      aria-hidden="true"
      data-v4-draft-logo="zcodium"
      viewBox="0 0 512 512"
      fill="currentColor"
      className={cn(
        "opacity-[0.14] dark:opacity-[0.2]",
        "[mask-image:linear-gradient(to_bottom,black_0%,black_60%,transparent_78%)]",
        "[mask-repeat:no-repeat] [mask-size:100%_100%]",
        "[-webkit-mask-image:linear-gradient(to_bottom,black_0%,black_60%,transparent_78%)]",
        "[-webkit-mask-repeat:no-repeat] [-webkit-mask-size:100%_100%]",
        className,
      )}
    >
      <path d={ZCODIUM_WATERMARK_PATH} />
    </svg>
  );
}
