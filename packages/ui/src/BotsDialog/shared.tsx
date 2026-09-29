import { Bot, Webhook } from "lucide-react";
import type { BotConfig, BotServiceStatus } from "@zcode/shared";
import { ALL_BOT_WORKSPACES, BOT_BIND_CODE_TTL_MS } from "@zcode/shared";
import {
  AstrBotChannelIcon,
  DingDingChannelIcon,
  DiscordChannelIcon,
  FeishuChannelIcon,
  TelegramChannelIcon,
  WeComChannelIcon,
  WeixinChannelIcon,
} from "@/assets/channel-icons/index.js";
import type { BotProviderEntryId } from "@/botsUi.js";
import { cn } from "@/components/lib/utils.js";

export type BindCodeState = {
  botId: string;
  code: string;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
};

export type FeishuRegistrationState = {
  botId: string;
  deviceCode: string;
  qrUrl: string;
  qrDataUrl: string | null;
  userCode: string;
  interval: number;
  expiresAt: number;
  domain: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
  status: "pending" | "success" | "access_denied" | "expired" | "error";
  message?: string;
};

export type WeixinRegistrationState = {
  botId: string;
  qrCode: string;
  qrUrl: string;
  qrDataUrl: string | null;
  interval: number;
  expiresAt: number;
  status: "pending" | "scanned" | "success" | "expired" | "error";
  message?: string;
};

export const BIND_CODE_TTL_MS = BOT_BIND_CODE_TTL_MS;
export const TELEGRAM_BOTFATHER_URL = "https://t.me/BotFather";

export function isAllWorkspacesAllowed(allowedWorkspaces: readonly string[]): boolean {
  return allowedWorkspaces.length === 0 || allowedWorkspaces.includes(ALL_BOT_WORKSPACES);
}

export function formatBotDisplayName(name: string, fallbackName: string): string {
  return name.trim() || fallbackName;
}

export function ProviderIcon({
  provider,
  className,
}: {
  provider?: BotProviderEntryId | "new";
  className?: string;
}) {
  const iconSrc =
    provider === "astrbot"
      ? AstrBotChannelIcon
      : provider === "telegram"
        ? TelegramChannelIcon
        : provider === "weixin"
          ? WeixinChannelIcon
          : provider === "feishu" || provider === "lark"
            ? FeishuChannelIcon
            : provider === "dingding"
              ? DingDingChannelIcon
              : provider === "discord"
                ? DiscordChannelIcon
                : provider === "wecom"
                  ? WeComChannelIcon
                  : null;

  if (iconSrc) {
    return (
      <img
        src={iconSrc}
        alt=""
        aria-hidden="true"
        className={cn("size-4 object-contain", className)}
      />
    );
  }

  if (provider === "webhook") {
    return <Webhook className={cn("size-4", className)} />;
  }
  return <Bot className={cn("size-4", className)} />;
}

export function runtimeText(
  runtime: BotServiceStatus["botRuntime"][number] | undefined,
  enabled: boolean,
  formatRuntimeMessage?: (id: string) => string,
): string {
  if (runtime?.messageId && formatRuntimeMessage) {
    return formatRuntimeMessage(runtime.messageId);
  }
  return runtime?.message ?? runtime?.status ?? (enabled ? "enabled" : "disabled");
}

export function runtimeDot(
  runtime: BotServiceStatus["botRuntime"][number] | undefined,
  enabled: boolean,
): string {
  if (runtime?.status === "error") return "bg-destructive";
  if (runtime?.status === "polling" || runtime?.status === "connected") return "bg-success";
  if (enabled) return "bg-foreground-subtle";
  return "bg-border";
}

export function formatBindCountdown(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 1000))}s`;
}

/**
 * 轮询结果深比较：字段顺序无关，Date 以毫秒值比较。
 * BotsDialog 的状态/配置轮询每 2 秒回新对象，内容不变时跳过 setState
 * 可以避免整棵设置树无谓重渲染。
 */
export function isDeepEqualPollingValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => isDeepEqualPollingValue(item, b[index]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      isDeepEqualPollingValue(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
  );
}

export function createDefaultCommands(): BotConfig["allowedCommands"] {
  return {
    status: true,
    new: true,
    workspace: true,
    model: true,
    mode: true,
    thoughtLevel: true,
    reply: true,
  };
}
