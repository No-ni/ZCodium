import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import androidEmulatorIconUrl from "@/assets/plugin-icons/android-emulator.png";
import browserUseIconUrl from "@/assets/plugin-icons/browser-use.png";
import computerUseIconUrl from "@/assets/plugin-icons/computer-use.png";
import documentsIconUrl from "@/assets/plugin-icons/documents.png";
import imageSearchIconUrl from "@/assets/plugin-icons/image-search.png";
import iosSimulatorIconUrl from "@/assets/plugin-icons/ios-simulator.png";
import pdfIconUrl from "@/assets/plugin-icons/pdf.png";
import pluginCreatorIconUrl from "@/assets/plugin-icons/plugin-creator.png";
import presentationsIconUrl from "@/assets/plugin-icons/presentations.png";
import restoreLegacySessionsIconUrl from "@/assets/plugin-icons/restore-legacy-sessions.png";
import skillCreatorIconUrl from "@/assets/plugin-icons/skill-creator.png";
import spreadsheetsIconUrl from "@/assets/plugin-icons/spreadsheets.png";
import visualizeIconUrl from "@/assets/plugin-icons/visualize.png";
import zcodeGuideIconUrl from "@/assets/plugin-icons/zcode-guide.png";
import { isTrustedImageUrl } from "@/lib/trustedImageUrl.js";

// 官方插件图标全部随包内置：内置市场不依赖官方服务，远程图片只可能来自用户自建市场。
const OFFICIAL_PLUGIN_ICON_BY_ID: Readonly<Record<string, string>> = {
  "android-emulator@zcode-plugins-official": androidEmulatorIconUrl,
  "browser-use@zcode-plugins-official": browserUseIconUrl,
  "computer-use@zcode-plugins-official": computerUseIconUrl,
  "documents@zcode-plugins-official": documentsIconUrl,
  "image-search@zcode-plugins-official": imageSearchIconUrl,
  "ios-simulator@zcode-plugins-official": iosSimulatorIconUrl,
  "pdf@zcode-plugins-official": pdfIconUrl,
  "plugin-creator@zcode-plugins-official": pluginCreatorIconUrl,
  "presentations@zcode-plugins-official": presentationsIconUrl,
  "restore-legacy-sessions@zcode-plugins-official": restoreLegacySessionsIconUrl,
  "skill-creator@zcode-plugins-official": skillCreatorIconUrl,
  "spreadsheets@zcode-plugins-official": spreadsheetsIconUrl,
  "visualize@zcode-plugins-official": visualizeIconUrl,
  "zcode-guide@zcode-plugins-official": zcodeGuideIconUrl,
};

const TRUSTED_BUNDLED_PLUGIN_ICONS = new Set(Object.values(OFFICIAL_PLUGIN_ICON_BY_ID));

/** 按完整身份解析客户端自有图标，避免商店、候选和消息各自维护不同例外。 */
export function resolvePluginIconSource(
  pluginId: string | undefined,
  icon?: string,
): string | undefined {
  if (pluginId) {
    const bundledIcon = OFFICIAL_PLUGIN_ICON_BY_ID[pluginId];
    if (bundledIcon) return bundledIcon;
    // 旧会话/缓存中的官方图片不能重新触发 CDN 请求；内置身份只使用随包资源。
    if (pluginId.endsWith(`@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`)) return undefined;
  }
  return isTrustedImageUrl(icon) ? icon : undefined;
}

/** Session 投影已完成身份匹配；仅放行固定打包资源，不放宽任意本地 URL。 */
export function isTrustedPluginIconSource(icon: string | undefined): icon is string {
  return Boolean(icon && TRUSTED_BUNDLED_PLUGIN_ICONS.has(icon)) || isTrustedImageUrl(icon);
}
