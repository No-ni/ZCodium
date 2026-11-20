import type { BotProviderCallbackResult, BotsConfigFile } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { BotProviderAdapter } from "./providers/types.js";
import { type BotRuntimeLogger, type BotRuntimeStatusSink } from "./channelRuntime.js";

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: unknown[];
  description?: string;
}

// Telegram 服务端长轮询最多等待 25 秒；客户端额外预留传输时间，但必须覆盖响应体读取，
// 避免半开连接永久占用 polling lock，导致配置刷新无法接管 runtime。
const TELEGRAM_LONG_POLL_REQUEST_TIMEOUT_MS = 40_000;

interface TelegramChannelRuntimeDeps {
  runBackgroundTasks?: boolean;
  credentialService: ICredentialService;
  telegramProvider: BotProviderAdapter | null;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  readConfig(): Promise<BotsConfigFile>;
  readTelegramOffset(botId: string): Promise<number | undefined>;
  writeTelegramOffset(botId: string, offset: number): Promise<void>;
  processProviderCallback(
    provider: "telegram",
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
export {
  type TelegramGetUpdatesResponse,
  TELEGRAM_LONG_POLL_REQUEST_TIMEOUT_MS,
  type TelegramChannelRuntimeDeps,
  isRecord,
};
