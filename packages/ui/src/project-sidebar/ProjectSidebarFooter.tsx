import type { ComponentProps } from "react";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import type { ProjectSidebarProps } from "./contract.js";
type Footer = ComponentProps<typeof WorkspaceSidebarFooter>;
export function ProjectSidebarFooter({
  props,
  localePreference,
  changeLocale,
  changeTheme,
  openSettings,
}: {
  props: ProjectSidebarProps;
  localePreference: Footer["localeMenuValue"];
  changeLocale: Footer["onLocaleChange"];
  changeTheme: Footer["onThemeChange"];
  openSettings: Footer["onSettingsButtonClick"];
}) {
  return (
    <WorkspaceSidebarFooter
      className="pr-3"
      theme={props.theme}
      localeMenuValue={localePreference}
      onLocaleChange={changeLocale}
      onThemeChange={changeTheme}
      onSettingsButtonClick={openSettings}
      onUsageClick={openSettings}
      workspacePath={props.workspacePath}
      // 项目侧栏不再从 tab 反推身份；远控入口必须沿用当前 attachment 的精确 scope。
      workspaceIdentity={props.workspaceIdentity}
      remoteSessionId={props.workspaceRemoteSessionId}
      isDesktop={props.isDesktop}
    />
  );
}
