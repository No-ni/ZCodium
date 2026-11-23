import type { Logger } from "@zcode/contracts";

interface AiSdkWarningLoggerOptions {
  model?: unknown;
  provider?: unknown;
  warnings?: unknown;
}

type AiSdkWarningLogger = (options: AiSdkWarningLoggerOptions) => void;

type AiSdkWarningGlobal = typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: false | AiSdkWarningLogger;
};

export function installZCodeProtocolAiSdkWarningLogger(logger: Logger): void {
  // AI SDK 默认 warning logger 第一次会用 console.info 写 stdout；
  // app-server --stdio 的 stdout 是 ZCode Protocol NDJSON 帧通道，任何普通文本都会让宿主解析失败。
  (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS = (
    options: AiSdkWarningLoggerOptions,
  ) => {
    try {
      const warnings = Array.isArray(options.warnings) ? options.warnings : [];
      logger.warn("AI SDK model warning", {
        event: "model.sdk.warning",
        module: "bootstrap.zcode_protocol",
        status: "completed",
        // 供应商 warning 可能带配置、URL 或原始错误；在出口只留下数量，stdout 继续只承载协议。
        count: warnings.length,
      });
    } catch {
      // warning 记录不能影响真实模型请求；stdout 纯净性由不调用 console.* 保证。
    }
  };
}
