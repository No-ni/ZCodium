import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  HTML_MIME,
  MAX_RESOURCE_BINARY_BYTES,
  MAX_RESOURCE_TEXT_BYTES,
  OfficeError,
  isOfficeAssetName,
} from "#office/contract.ts";

export const isAssetName = isOfficeAssetName;

export type OfficeAsset =
  | { mimeType: string; text: string; blob?: never }
  | { mimeType: string; blob: string; text?: never };

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

/**
 * 中文说明：白名单只约束名称，不能阻止合法 fonts/bundle 名称链接到包外；面板和资源统一
 * realpath 后再次 containment，且以 wire/base64 预算限量。此适配器没有任何写入路径。
 */
export function createOfficeAssets(assetRoot: string) {
  return {
    async read(name: string): Promise<OfficeAsset> {
      if (name !== "panel.html" && !isAssetName(name))
        throw new OfficeError("invalid_resource", "Invalid local viewer resource.");
      try {
        const root = await realpath(assetRoot);
        const candidate = join(root, name);
        if (!contained(root, candidate)) throw new Error("invalid resource");
        const actual = await realpath(candidate);
        if (!contained(root, actual)) throw new Error("invalid resource");
        const text = /\.(txt|css|json|js|html)$/.test(name);
        const maxBytes = text ? MAX_RESOURCE_TEXT_BYTES : MAX_RESOURCE_BINARY_BYTES;
        const info = await stat(actual);
        if (!info.isFile() || info.size > maxBytes) throw new Error("invalid resource");
        const bytes = await readFile(actual);
        if (bytes.byteLength > maxBytes) throw new Error("invalid resource");
        if (!text) return { mimeType: "application/octet-stream", blob: bytes.toString("base64") };
        const mimeType =
          name === "panel.html"
            ? HTML_MIME
            : name.endsWith(".json")
              ? "application/json"
              : name.endsWith(".css")
                ? "text/css"
                : "text/plain";
        return { mimeType, text: bytes.toString("utf8") };
      } catch {
        // 原始 fs 错误带绝对路径；资源出口保留稳定错误，不泄漏 raw message/stack。
        throw new OfficeError("invalid_resource", "Local viewer resource is unavailable.");
      }
    },
  };
}
