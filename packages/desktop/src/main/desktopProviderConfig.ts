import { app } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BuiltinProviderConfigFileInfo } from "@zcode/shared";
import { getAppConfigDir } from "@zcode/services/node";
import { resolveZCodeBuiltinProviderConfigFilePath as resolveMaterializedPath } from "@zcode/provider-node";

export function resolveZCodeBuiltinProviderConfigFilePath(options?: {
  readonly appPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
}): string {
  const explicitPath = (options?.env ?? process.env)["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim();
  if (explicitPath) return explicitPath;
  if (options?.isPackaged ?? app.isPackaged) {
    return join(
      options?.resourcesPath ?? process.resourcesPath,
      "config/provider/zcode-builtin.json",
    );
  }
  // 开发态与打包共用唯一线上配置源。
  const filename = "zcode-builtin.json";
  return join(options?.appPath ?? app.getAppPath(), "../../config/provider", filename);
}

/**
 * 查询运行时真正生效的 Provider 配置：Host/Services 启动时会把随包配置物化到
 * `<appConfigDir>/runtime/provider/bundled/zcode-builtin.json`，之后由
 * NodeZCodeBuiltinProviderConfigSource 只读监听该副本。
 *
 * 打开源配置（resources 内或 env 指定的那份）对用户没有意义：macOS 打包态位于只读
 * bundle 内，且它只是基线，物化副本才是生效且可写的那份。
 * 未启动过 server 时副本不存在，返回 exists=false，由调用方禁用入口。
 */
export function getBuiltinProviderConfigFileInfo(): BuiltinProviderConfigFileInfo {
  try {
    const path = resolveMaterializedPath(getAppConfigDir());
    return { path, exists: existsSync(path) };
  } catch {
    // 数据根目录不可解析（如 ZCODE_DATA_BASE_DIR 异常）时不能让 IPC 抛错，
    // 返回 path=null 让渲染层禁用入口并给出原因。
    return { path: null, exists: false };
  }
}
