import {
  ASSET_PREFIX,
  FILE_PREFIX,
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  MAX_RESOURCE_BINARY_BYTES,
  MAX_RESOURCE_TEXT_BYTES,
  type FileHandle,
} from "#office/contract.ts";
import { getHost } from "#ui/host.ts";
import { localAssetName } from "#ui/resourceManifest.ts";

async function read(uri: string) {
  const host = getHost();
  await host.ready();
  const result = await host.app.readServerResource({ uri });
  const item = result.contents[0];
  if (!item) throw new Error(`Empty resource ${uri}`);
  return item as { text?: string; blob?: string };
}

export async function readText(name: string): Promise<string> {
  const item = await read(ASSET_PREFIX + localAssetName(name));
  if (
    typeof item.text !== "string" ||
    new TextEncoder().encode(item.text).byteLength > MAX_RESOURCE_TEXT_BYTES
  )
    throw new Error("Invalid local text resource.");
  return item.text;
}

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const binaryCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

/** Binary asset (wasm, pdf.js cMaps and fonts); cached for the life of the page. */
export function readBinary(name: string): Promise<Uint8Array<ArrayBuffer>> {
  localAssetName(name);
  let cached = binaryCache.get(name);
  if (!cached) {
    cached = read(ASSET_PREFIX + name).then((item) => {
      if (
        typeof item.blob !== "string" ||
        item.blob.length > Math.ceil(MAX_RESOURCE_BINARY_BYTES / 3) * 4
      )
        throw new Error("Invalid local binary resource.");
      const bytes = decode(item.blob);
      if (bytes.byteLength > MAX_RESOURCE_BINARY_BYTES)
        throw new Error("Local resource exceeds its limit.");
      return bytes;
    });
    cached.catch(() => binaryCache.delete(name));
    binaryCache.set(name, cached);
  }
  return cached;
}

/** Read a loaded document's bytes chunk by chunk. */
export async function readFileBytes(
  handle: FileHandle,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (
    !Number.isSafeInteger(handle.bytes) ||
    handle.bytes < 0 ||
    handle.bytes > MAX_FILE_BYTES ||
    !Number.isSafeInteger(handle.chunks) ||
    handle.chunks !== Math.max(1, Math.ceil(handle.bytes / FILE_CHUNK_BYTES)) ||
    !/^[\da-f-]{36}$/i.test(handle.token)
  )
    throw new Error("Invalid document file handle.");
  const out = new Uint8Array(handle.bytes);
  let offset = 0;
  for (let index = 0; index < handle.chunks; index++) {
    signal?.throwIfAborted();
    const item = await read(`${FILE_PREFIX}${handle.token}/${index}`);
    if (typeof item.blob !== "string" || item.blob.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4)
      throw new Error("File chunk is not bounded binary data.");
    const chunk = decode(item.blob);
    if (chunk.byteLength !== Math.min(FILE_CHUNK_BYTES, handle.bytes - offset))
      throw new Error("Invalid document file chunk.");
    signal?.throwIfAborted();
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== handle.bytes) throw new Error("The file changed while it was loading; reload it.");
  return out.buffer;
}
