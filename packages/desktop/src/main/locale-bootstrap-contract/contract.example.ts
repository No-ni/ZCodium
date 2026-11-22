import type { DesktopLocaleBootstrapEntry } from "./contract.js";
/** 沿既有 API 调用，不建立新的持久化或状态所有者。 */
export function exampleDesktopLocaleBootstrap(api: DesktopLocaleBootstrapEntry, home: string) {
  return api.readBootstrapApplicationLocale(
    api.resolveApplicationLocaleBootstrapSettingsFile(home),
  );
}
