import type { ReactNode } from "react";
import { ZCodeStartupLogoBadge } from "@/root/ZCodeStartupLogoBadge.js";
import { StartupPresentationReady } from "./StartupPresentationReady.js";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

/**
 * 启动门禁期间的满屏底与品牌标记。
 *
 * HTML 动画层跨数据库与工作区恢复连续存在；本组件保留静态标记与主题底，
 * 让没有桌面遮罩的入口以及异常恢复路径也始终有可用画面，不重新播放入场。
 */
export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      {!busy ? <StartupPresentationReady immediate /> : null}
      <ZCodeStartupLogoBadge />
      {children}
    </div>
  );
}
