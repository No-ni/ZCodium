/** 显式复用本轮桌面测试构建；不装配已退休的官方套餐页面。 */
export function shouldReuseDesktopE2EBuild(
  environment: Record<string, string | undefined>,
): boolean {
  return environment.ZCODE_E2E_SKIP_BUILD === "1";
}
