import type { ImagePrepareForModelResult } from "@zcode/contracts";
import type { NativeImagePolicy } from "./image-policy.js";

export class NativeImageCopyCache {
  private readonly entries = new Map<string, ImagePrepareForModelResult>();
  private sizeBytes = 0;
  private maxEntries = 0;
  private maxBytes = 0;

  configure(policy: NativeImagePolicy): void {
    this.maxEntries = policy.cacheMaxEntries;
    this.maxBytes = policy.cacheMaxMiB * 1024 * 1024;
    this.trim();
  }

  get(key: string): ImagePrepareForModelResult | undefined {
    const result = this.entries.get(key);
    if (!result) return undefined;
    this.entries.delete(key);
    this.entries.set(key, result);
    return copyResult(result);
  }

  put(key: string, result: ImagePrepareForModelResult): void {
    if (
      !this.maxEntries ||
      !this.maxBytes ||
      !result.compressed ||
      result.data.byteLength > this.maxBytes
    )
      return;
    const previous = this.entries.get(key);
    if (previous) {
      this.sizeBytes -= previous.data.byteLength;
      this.entries.delete(key);
    }
    this.entries.set(key, copyResult(result));
    this.sizeBytes += result.data.byteLength;
    this.trim();
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries || this.sizeBytes > this.maxBytes) {
      const key = this.entries.keys().next().value;
      if (key === undefined) break;
      const entry = this.entries.get(key)!;
      this.sizeBytes -= entry.data.byteLength;
      this.entries.delete(key);
    }
  }
}

function copyResult(result: ImagePrepareForModelResult): ImagePrepareForModelResult {
  return { ...result, data: Buffer.from(result.data) };
}
