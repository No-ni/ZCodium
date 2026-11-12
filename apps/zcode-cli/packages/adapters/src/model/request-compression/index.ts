// 渠道级请求压缩：只编码上传正文，明文改写与响应处理仍由外层负责。
import { promisify } from "node:util";
import type { RequestCompressionAlgorithm, RequestCompressionFetchOptions } from "./contract.js";

type ProviderFetch = typeof globalThis.fetch;

export type {
  RequestCompressionAlgorithm,
  RequestCompressionFetchOptions,
  RequestCompressionState,
} from "./contract.js";

type ActiveCompressionAlgorithm = Exclude<RequestCompressionAlgorithm, "off">;
const CONTENT_ENCODING_HEADER = "content-encoding";
const CONTENT_LENGTH_HEADER = "content-length";
const CONTENT_TYPE_HEADER = "content-type";
const JSON_CONTENT_TYPE_PATTERN = /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/iu;
const UNSUPPORTED_MEDIA_TYPE_STATUS = 415;
const BROTLI_QUALITY = 4;
const ERROR_HTTP_STATUS_FIELDS = ["responseStatus", "statusCode"] as const;
const CONTENT_ENCODING_BY_ALGORITHM: Record<ActiveCompressionAlgorithm, string> = {
  brotli: "br",
  gzip: "gzip",
};

interface RequestBodySnapshot {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit;
  readonly headers: Headers;
  readonly bodyText: string;
  readonly signal?: AbortSignal | null;
}

interface CompressedAttempt {
  readonly request: RequestInfo | URL;
  readonly init?: RequestInit;
}

type AttemptOutcome =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "failure"; readonly error: unknown };

/** 压缩层位于 option map / 协议兼容层之内，紧贴 transport。 */
export function createRequestCompressionFetch(
  options: RequestCompressionFetchOptions,
): ProviderFetch {
  if (options.algorithm === "off") return options.fetch;

  return async (input, init) => {
    const signal =
      init?.signal === undefined && input instanceof Request ? input.signal : init?.signal;
    // 根因：原实现直到底层 fetch 才看 signal，已取消的请求仍执行昂贵压缩。
    signal?.throwIfAborted();
    const snapshot = captureRequestBody(input, init, signal);
    if (!snapshot) return options.fetch(input, init);

    const algorithm =
      options.algorithm === "brotli" && !options.state?.brotliUnsupported ? "brotli" : "gzip";
    const attempt = await createCompressedAttempt(snapshot, algorithm, options);
    const outcome = await sendCompressedAttempt(attempt, options, signal);
    rejectCancelledOutcome(outcome, signal);
    const rejectedStatus = readRejectedStatus(outcome);
    // 普通 400 包含参数/上下文错误，不能证明 br 不可用，也不能丢弃原错误体重发。
    if (algorithm !== "brotli" || rejectedStatus !== UNSUPPORTED_MEDIA_TYPE_STATUS) {
      return unwrapAttempt(outcome);
    }

    discardAttemptBody(outcome);
    signal?.throwIfAborted();
    // 重发复用首个 await 前捕获的正文和头；不能重新读取已被调用方改写的 init。
    const gzipAttempt = await createCompressedAttempt(snapshot, "gzip", options);
    const retried = await sendCompressedAttempt(gzipAttempt, options, signal);
    rejectCancelledOutcome(retried, signal);
    // gzip 仍失败不能证明成功降级，否则参数错误会把整个渠道永久降为 gzip。
    if (retried.kind === "response" && retried.response.ok) {
      if (options.state) options.state.brotliUnsupported = true;
      options.logger?.warn("provider request compression downgraded to gzip", {
        providerId: options.providerId,
        responseStatus: rejectedStatus,
      });
    }
    return unwrapAttempt(retried);
  };
}

function captureRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  signal: AbortSignal | null | undefined,
): RequestBodySnapshot | undefined {
  // Request 自带的正文已统一为流，无法确认来自字符串还是无限流；不能 clone().text() 无界读取。
  if (typeof init?.body !== "string" || init.body.length === 0) return undefined;
  const headers = new Headers(
    init.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (
    headers.has(CONTENT_ENCODING_HEADER) ||
    !isJsonContentType(headers.get(CONTENT_TYPE_HEADER))
  ) {
    return undefined;
  }
  return {
    input: input instanceof URL ? new URL(input.href) : input,
    init: { ...init },
    headers,
    bodyText: init.body,
    signal,
  };
}

async function createCompressedAttempt(
  snapshot: RequestBodySnapshot,
  algorithm: ActiveCompressionAlgorithm,
  options: RequestCompressionFetchOptions,
): Promise<CompressedAttempt> {
  snapshot.signal?.throwIfAborted();
  const body = await waitForCompressionOrAbort(
    compressBodyText(snapshot.bodyText, algorithm, snapshot.signal),
    snapshot.signal,
  );
  snapshot.signal?.throwIfAborted();
  const headers = new Headers(snapshot.headers);
  headers.set(CONTENT_ENCODING_HEADER, CONTENT_ENCODING_BY_ALGORITHM[algorithm]);
  headers.delete(CONTENT_LENGTH_HEADER);
  options.logger?.debug("provider request compressed", {
    providerId: options.providerId,
    algorithm,
    originalBytes: Buffer.byteLength(snapshot.bodyText, "utf8"),
    compressedBytes: body.byteLength,
  });
  const init = { ...snapshot.init, body, headers };
  return snapshot.input instanceof Request
    ? { request: new Request(snapshot.input, init) }
    : { request: snapshot.input, init };
}

async function sendCompressedAttempt(
  attempt: CompressedAttempt,
  options: RequestCompressionFetchOptions,
  signal?: AbortSignal | null,
): Promise<AttemptOutcome> {
  // await 压缩结果到调用 transport 之间仍可能取消，发送入口必须再次检查，不能只靠原生 fetch。
  signal?.throwIfAborted();
  try {
    return { kind: "response", response: await options.fetch(attempt.request, attempt.init) };
  } catch (error) {
    return { kind: "failure", error };
  }
}

function unwrapAttempt(outcome: AttemptOutcome): Response {
  if (outcome.kind === "response") return outcome.response;
  throw outcome.error;
}

function readRejectedStatus(outcome: AttemptOutcome): number | undefined {
  if (outcome.kind === "response") return outcome.response.status;
  const error = outcome.error;
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const field of ERROR_HTTP_STATUS_FIELDS) {
    const value = record[field];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}

function discardAttemptBody(outcome: AttemptOutcome): void {
  if (outcome.kind !== "response") return;
  // 不等待取消流的底层清理，否则迟迟未结束的错误流会阻塞重发/取消。
  void outcome.response.body?.cancel().catch(() => undefined);
}

function rejectCancelledOutcome(outcome: AttemptOutcome, signal?: AbortSignal | null): void {
  if (!signal?.aborted) return;
  discardAttemptBody(outcome);
  signal.throwIfAborted();
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && JSON_CONTENT_TYPE_PATTERN.test(value.trim());
}

async function compressBodyText(
  text: string,
  algorithm: ActiveCompressionAlgorithm,
  signal?: AbortSignal | null,
): Promise<ArrayBuffer> {
  // off 不加载 zlib；默认最高质量曾让 5.6MB 图片正文压缩超过 5 秒，固定 quality=4 限制成本。
  const { brotliCompress, gzip, constants } = await import("node:zlib");
  signal?.throwIfAborted();
  const source = Buffer.from(text, "utf8");
  const compressed =
    algorithm === "brotli"
      ? await promisify(brotliCompress)(source, {
          params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
        })
      : await promisify(gzip)(source);
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  return copy.buffer;
}

function waitForCompressionOrAbort<T>(
  pending: Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    // 先观察原 Promise 再检查取消，避免迟到的 zlib reject 变成 unhandled rejection。
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
