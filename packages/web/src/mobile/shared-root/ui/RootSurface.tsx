import { AppErrorBoundary, Button, Root, ZCodeIntlProvider, useZCodeIntl } from "@zcode/ui";
import { useCallback } from "react";
import type { MobileRootSnapshot } from "../contract.js";

interface RootSurfaceProps {
  snapshot: MobileRootSnapshot;
  title: string;
  description: string;
  notice?: string | null;
  onRetry(): void;
}

function PendingWorkspace({ snapshot, title, description, notice, onRetry }: RootSurfaceProps) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex h-full min-h-0 min-w-0 items-center justify-center bg-background px-4 text-foreground">
      <section
        className="w-full max-w-sm rounded-xl border border-border bg-card p-5"
        aria-live="polite"
      >
        <h1 className="text-ui-lg font-medium">{title}</h1>
        <p className="mt-2 text-ui-base text-foreground-subtle">{description}</p>
        {snapshot.error ? (
          <p className="mt-2 text-ui-base text-destructive" role="alert">
            {intl.formatMessage({ id: "webRemoteControl.failure.invalidMobileConnection" })}
          </p>
        ) : null}
        {notice ? (
          <p className="mt-2 text-ui-base text-foreground-subtle" role="status">
            {notice}
          </p>
        ) : null}
        {snapshot.error ? (
          <Button type="button" variant="outline" size="sm" className="mt-4" onClick={onRetry}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        ) : null}
      </section>
    </div>
  );
}

/** 页面不再保存独立会话投影；只有同代有效 slot 能挂载共享 Root。 */
export function RootSurface(props: RootSurfaceProps) {
  const slot = props.snapshot.slot;
  const current = slot?.access.isCurrent() ? slot : null;
  const resolveSystemLocale = useCallback(async () => {
    const assertCurrent = () => {
      if (current?.rootProps.initialTaskDraft?.isCurrent?.() !== true)
        throw new Error("mobile-workspace-superseded");
    };
    assertCurrent();
    const locale = await current!.rootProps.platform.getSystemLocale?.();
    // 同桥换 slot 不会作废平台 accessor；旧语言选择仍须在异步返回后复检页面租约。
    assertCurrent();
    if (locale !== "zh-CN" && locale !== "en-US")
      throw new Error("mobile-system-locale-unavailable");
    return locale;
  }, [current]);
  return (
    <AppErrorBoundary key={current?.key ?? "mobile-connection"}>
      <ZCodeIntlProvider
        settingService={current?.access.services.settingService}
        broadcastService={current?.access.services.broadcastService}
        preferSettingServiceLocale
        resolveSystemLocale={
          current?.rootProps.platform.getSystemLocale ? resolveSystemLocale : undefined
        }
      >
        {current ? <Root {...current.rootProps} /> : <PendingWorkspace {...props} />}
      </ZCodeIntlProvider>
    </AppErrorBoundary>
  );
}
