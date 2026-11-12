import type { Logger } from "@zcode/contracts";

/** 渠道级压缩算法；off 表示完全旁路，连 body 都不读。 */
export type RequestCompressionAlgorithm = "off" | "brotli" | "gzip";

/**
 * 单个渠道在本次进程内的压缩事实。
 *
 * 由执行器按 providerId / Base URL / 协议持有并复用；只有 gzip 重发成功才更新，
 * 它是纯运行时事实，不落盘、不进配置，进程重启后允许重新尝试 brotli。
 */
export interface RequestCompressionState {
  brotliUnsupported: boolean;
}

export interface RequestCompressionFetchOptions {
  /** 内层 transport：代理/证书已装配；调用前外层已完成明文 option map 与协议兼容。 */
  readonly fetch: typeof globalThis.fetch;
  /** 只用于日志与记忆分桶，不参与请求构造。 */
  readonly providerId: string;
  readonly algorithm: RequestCompressionAlgorithm;
  readonly state?: RequestCompressionState;
  readonly logger?: Logger;
}
