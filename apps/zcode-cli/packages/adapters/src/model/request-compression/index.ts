// 渠道级请求压缩：只压缩上传正文，不改变响应处理。
// 参考 No-ni/dsh-plugin-model-request-accelerator 的请求体压缩思路，按本仓传输层装配方式重写。

import { brotliCompress, gzip } from "node:zlib";
import { promisify } from "node:util";
import type {
  RequestCompressionAlgorithm,
  RequestCompressionFetchOptions,
} from "./contract.js";

type ProviderFetch = typeof globalThis.fetch;

export type {
  RequestCompressionAlgorithm,
  RequestCompressionFetchOptions,
  RequestCompressionState,
} from "./contract.js";

/** 已解析出的实际压缩方式：只在开启时才存在。 */
type ActiveCompressionAlgorithm = Exclude<RequestCompressionAlgorithm, "off">;

const CONTENT_ENCODING_HEADER = "content-encoding";
const CONTENT_LENGTH_HEADER = "content-length";
const CONTENT_TYPE_HEADER = "content-type";
// 只压缩 JSON 正文：multipart、二进制媒体和流式正文由调用方原样发送。
const JSON_CONTENT_TYPE_PATTERN = /\bapplication\/(?:[\w.+-]*\+)?json\b/iu;
// 网关拒绝压缩正文时通常先落到这两个状态码，用来触发一次 gzip 降级重发。
const COMPRESSION_REJECTED_STATUSES = new Set([400, 415]);
// 内层 business-error 层对非 2xx 会直接抛错，HTTP 状态只能从这些结构化字段读回。
// 只读结构化字段、不读错误文本，避免按文案做流程判断。
const ERROR_HTTP_STATUS_FIELDS = ["responseStatus", "statusCode"] as const;
const CONTENT_ENCODING_BY_ALGORITHM: Record<ActiveCompressionAlgorithm, string> = {
  brotli: "br",
  gzip: "gzip",
};

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/**
 * 在传输层之前包一层请求压缩。
 *
 * 必须位于 option map 与协议兼容层之内（更贴近 wire）：那些层要读写明文 JSON 正文，
 * 先压缩会让它们 fail-closed（option map 抛 "Model option maps require a JSON text request body."）。
 */
export function createRequestCompressionFetch(options: RequestCompressionFetchOptions): ProviderFetch {
  if (options.algorithm === "off") {
    return options.fetch;
  }

  return async (input, init) => {
    const attempt = await createCompressedAttempt(
      input,
      init,
      resolveActiveAlgorithm(options),
      options,
    );
    if (!attempt) {
      return options.fetch(input, init);
    }

    // 内层既可能是纯 transport（返回 415 响应），也可能被 business-error 层包住而把非 2xx
    // 转成异常（装配顺序变化时会这样）。两种形态都必须接住，否则 brotli 降级分支永远不执行，
    // 用户只会看到一个无法归因的 4xx。
    const outcome = await sendCompressedAttempt(attempt, options);
    if (attempt.algorithm !== "brotli") {
      return unwrapAttempt(outcome);
    }
    const rejectedStatus = readRejectedStatus(outcome);
    if (rejectedStatus === undefined || !COMPRESSION_REJECTED_STATUSES.has(rejectedStatus)) {
      return unwrapAttempt(outcome);
    }

    // 网关不认 br 时必须自己降级，否则用户只会看到一个无法归因的 4xx。
    // 正文仍在内存里，因此重发是安全的；只重发一次，避免把真正的报文错误放大成两条请求。
    await discardAttemptBody(outcome);
    if (options.state) {
      options.state.brotliUnsupported = true;
    }
    options.logger?.warn("provider request compression downgraded to gzip", {
      providerId: options.providerId,
      // 不能用 status：LogContext 的 status 是生命周期枚举，这里要表达的是 HTTP 状态码。
      responseStatus: rejectedStatus,
    });

    const gzipAttempt = await createCompressedAttempt(input, init, "gzip", options);
    if (!gzipAttempt) {
      return options.fetch(input, init);
    }
    return unwrapAttempt(await sendCompressedAttempt(gzipAttempt, options));
  };
}

interface CompressedAttempt {
  readonly request: RequestInfo | URL;
  readonly init?: RequestInit;
  readonly algorithm: ActiveCompressionAlgorithm;
}

/** 一次发送的结果：把「返回响应」和「抛出错误」统一成一个值，供降级判断读取状态码。 */
type AttemptOutcome =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "failure"; readonly error: unknown };

function resolveActiveAlgorithm(options: RequestCompressionFetchOptions): ActiveCompressionAlgorithm {
  return options.algorithm === "brotli" && !options.state?.brotliUnsupported ? "brotli" : "gzip";
}

async function sendCompressedAttempt(
  attempt: CompressedAttempt,
  options: RequestCompressionFetchOptions,
): Promise<AttemptOutcome> {
  try {
    return { kind: "response", response: await options.fetch(attempt.request, attempt.init) };
  } catch (error) {
    return { kind: "failure", error };
  }
}

function unwrapAttempt(outcome: AttemptOutcome): Response {
  if (outcome.kind === "response") {
    return outcome.response;
  }
  throw outcome.error;
}

function readRejectedStatus(outcome: AttemptOutcome): number | undefined {
  return outcome.kind === "response" ? outcome.response.status : readErrorHttpStatus(outcome.error);
}

function readErrorHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  for (const field of ERROR_HTTP_STATUS_FIELDS) {
    const value = record[field];
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
  }
  return undefined;
}

async function discardAttemptBody(outcome: AttemptOutcome): Promise<void> {
  if (outcome.kind !== "response") {
    return;
  }
  try {
    await outcome.response.body?.cancel();
  } catch {
    // 少数运行时不支持取消已开始的响应流；丢弃失败不影响重发。
  }
}

async function createCompressedAttempt(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  algorithm: ActiveCompressionAlgorithm,
  options: RequestCompressionFetchOptions,
): Promise<CompressedAttempt | undefined> {
  const headers = new Headers(resolveHeaders(input, init));
  // 调用方已自行编码正文时不能再压：二次编码会把正文写坏，此时跳过压缩、原样发送。
  if (headers.has(CONTENT_ENCODING_HEADER)) {
    return undefined;
  }

  const bodyText = await readJsonBodyText(input, init, headers);
  if (bodyText === undefined) {
    return undefined;
  }

  const compressedBody = await compressBodyText(bodyText, algorithm);
  // 只记录字节数与算法：足以判断压缩是否生效，且不落任何正文、URL 或凭据。
  options.logger?.debug("provider request compressed", {
    providerId: options.providerId,
    algorithm,
    originalBytes: Buffer.byteLength(bodyText, "utf8"),
    compressedBytes: compressedBody.byteLength,
  });
  headers.set(CONTENT_ENCODING_HEADER, CONTENT_ENCODING_BY_ALGORITHM[algorithm]);
  // 压缩后长度必然变化；清掉旧值让运行时按新字节数重算，避免 content-length 与正文不符。
  headers.delete(CONTENT_LENGTH_HEADER);

  if (input instanceof Request) {
    return {
      request: new Request(input, { ...init, body: compressedBody, headers }),
      algorithm,
    };
  }
  return {
    request: input,
    init: { ...init, body: compressedBody, headers },
    algorithm,
  };
}

async function readJsonBodyText(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  headers: Headers,
): Promise<string | undefined> {
  if (typeof init?.body === "string") {
    if (!isJsonContentType(headers.get(CONTENT_TYPE_HEADER))) {
      return undefined;
    }
    return init.body.length > 0 ? init.body : undefined;
  }
  // FormData、二进制与流式正文没有可重放的文本形态，一律原样发送。
  if (init?.body !== undefined && init.body !== null) {
    return undefined;
  }
  if (!(input instanceof Request)) {
    return undefined;
  }
  if (!isJsonContentType(headers.get(CONTENT_TYPE_HEADER))) {
    return undefined;
  }
  try {
    const text = await input.clone().text();
    return text.length > 0 ? text : undefined;
  } catch {
    // 正文不可重放（已被消费或为流）时不压缩，请求继续按原样发出。
    return undefined;
  }
}

function resolveHeaders(input: RequestInfo | URL, init: RequestInit | undefined): Headers {
  if (init?.headers !== undefined) {
    return new Headers(init.headers);
  }
  return input instanceof Request ? new Headers(input.headers) : new Headers();
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && JSON_CONTENT_TYPE_PATTERN.test(value);
}

async function compressBodyText(
  text: string,
  algorithm: ActiveCompressionAlgorithm,
): Promise<ArrayBuffer> {
  const source = Buffer.from(text, "utf8");
  const compressed =
    algorithm === "brotli" ? await brotliCompressAsync(source) : await gzipAsync(source);
  // 交给 fetch 的必须是 ArrayBuffer 支撑的视图：Buffer 的 buffer 类型是 ArrayBufferLike，
  // 在 DOM BodyInit 下不可赋值，因此复制到独立的 ArrayBuffer。
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  return copy.buffer;
}
