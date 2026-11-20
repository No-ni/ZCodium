/**
 * 资源可声明的浏览器权限（规范草案 `UIResourceMeta.permissions` 的四键），顺序即归一化顺序。
 * 宿主：未声明一律拒绝；camera / microphone / geolocation 首次使用时原生弹框确认，clipboardWrite 按声明放行。
 */
export const MCP_APPS_RESOURCE_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "clipboardWrite",
] as const;

export type McpAppsResourcePermission = (typeof MCP_APPS_RESOURCE_PERMISSIONS)[number];

/** 规范权限键 → 插件 iframe `allow` 的 Permissions Policy 特性名。 */
export const MCP_APPS_IFRAME_ALLOW_TOKENS: Record<McpAppsResourcePermission, string> = {
  camera: "camera",
  microphone: "microphone",
  geolocation: "geolocation",
  clipboardWrite: "clipboard-write",
};

/** 与官方 SDK `buildAllowAttribute` 同形：`"camera; clipboard-write"`；没有声明返回空串。 */
export function buildMcpAppsIframeAllow(
  permissions: readonly McpAppsResourcePermission[] | undefined,
): string {
  if (!permissions?.length) return "";
  return MCP_APPS_RESOURCE_PERMISSIONS.filter((key) => permissions.includes(key))
    .map((key) => MCP_APPS_IFRAME_ALLOW_TOKENS[key])
    .join("; ");
}
