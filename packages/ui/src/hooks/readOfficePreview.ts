import type { IFileService } from "@zcode/services";
import { decodeBase64ToArrayBuffer } from "@/lib/officeFilePreview.js";

const MAX_OFFICE_BYTES = 25 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 4;

/** 通过已有服务契约读取，顶层 Uint8Array 使用 RPC 原始字节通道。 */
export async function readOfficePreview(
  service: Pick<IFileService, "stat" | "readFileRange" | "readBinaryPreview">,
  path: string,
  isDisposed: () => boolean,
): Promise<ArrayBuffer | null> {
  const initial = await service.stat({ path });
  if (isDisposed()) return null;
  if (initial.type !== "file") throw new Error(`Path is not a file: ${path}`);
  if (initial.size === undefined) {
    // 与已有 PDF/PPTX 相同：仅旧 Host 缺失 size/range 时沿用旧协议。
    const preview = await service.readBinaryPreview({ path });
    return isDisposed() ? null : decodeBase64ToArrayBuffer(preview.dataBase64);
  }
  if (!Number.isSafeInteger(initial.size) || initial.size < 0) throw new Error("Invalid file size");
  if (initial.size > MAX_OFFICE_BYTES) throw new Error(`File is too large to preview: ${path}`);
  const bytes = new Uint8Array(initial.size);
  // 有界并发减少远端逐页 RTT，最多四块在途；取消后不再发下一批。
  for (let start = 0; start < bytes.length; start += CHUNK_BYTES * READ_CONCURRENCY) {
    if (isDisposed()) return null;
    await Promise.all(
      Array.from({ length: READ_CONCURRENCY }, async (_, index) => {
        const offset = start + index * CHUNK_BYTES;
        if (offset >= bytes.length) return;
        const length = Math.min(CHUNK_BYTES, bytes.length - offset);
        const chunk = await service.readFileRange({ path, offset, length });
        if (isDisposed()) return;
        if (chunk.byteLength !== length) throw new Error("File changed while reading preview");
        bytes.set(chunk, offset);
      }),
    );
  }
  if (isDisposed()) return null;
  const final = await service.stat({ path });
  if (isDisposed()) return null;
  if (
    final.size !== initial.size ||
    (initial.mtimeMs !== undefined && final.mtimeMs !== initial.mtimeMs)
  ) {
    throw new Error("File changed while reading preview");
  }
  return bytes.buffer;
}
