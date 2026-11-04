import { useCallback, useEffect, useState } from "react";
import type { IPlatformService, TabId } from "@zcode/shared";
import { useZCodeIntl } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { useRootPlatformEffects } from "../../../packages/ui/src/root/useRootPlatformEffects.js";
import { useZCodeSessionStore } from "../../../packages/ui/src/store/zcodeSessionStore.js";
import type { WindowTabState } from "../../../packages/ui/src/store/tabStore.js";

const noop = () => {};
const path = "/fixture/project";
const identity = "remote:server:fixture-source:/fixture/project";
const taskId = "E2E_NOTICE_TASK";
const tabs: WindowTabState[] = [
  {
    id: "fixture-tab" as TabId,
    kind: "workspace",
    label: "Fixture",
    workspacePath: path,
    workspaceIdentity: identity,
  },
];
const handlers = new Map<string, Set<(payload: never) => void>>();
function subscribe(name: string) {
  const listeners = new Set<(payload: never) => void>();
  handlers.set(name, listeners);
  return (handler: (payload: never) => void) => {
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  };
}
export const rootPlatformEventAdapters = {
  onTaskNotificationClick: subscribe("notification"),
  onOpenWorkspacePath: subscribe("openPath"),
  onUpdateCheckResult: subscribe("update"),
};
const calls = {
  opened: [] as { version: number; path: string }[],
  activated: [] as { path: string; identity?: string }[],
};
export const rootEventsFixture = {
  calls,
  emit: (name: string, payload: unknown) => {
    for (const handler of handlers.get(name) ?? []) handler(payload as never);
  },
  listenerCounts: () => [...handlers.values()].map((listeners) => listeners.size),
  storeKeys: () => Object.keys(useZCodeSessionStore.getState().workspaces),
  setVersion: (_version: number) => {},
  setAllowed: (_allowed: boolean) => {},
  setLocale: (_locale: "en-US" | "zh-CN") => {},
  unmount: () => {},
};

function Effects({
  platform,
  version,
  allowed,
}: {
  platform: IPlatformService;
  version: number;
  allowed: boolean;
}) {
  const { intl, locale, setLocale } = useZCodeIntl();
  rootEventsFixture.setLocale = setLocale;
  const activateTabByPath = useCallback(
    (value: string, options?: { workspaceIdentity?: string }) => {
      calls.activated.push({ path: value, identity: options?.workspaceIdentity });
      return true;
    },
    [],
  );
  const openWorkspacePath = useCallback(
    (value: string) => {
      calls.opened.push({ version, path: value });
    },
    [version],
  );
  useEffect(() => {
    useZCodeSessionStore.getState().setActiveTaskId(path, taskId, identity);
  }, []);
  useRootPlatformEffects({
    canBootstrapInitialWorkspace: false,
    platform,
    isDesktop: true,
    locale,
    intl,
    tabs,
    addTab: noop,
    setIsBootstrappingInitialWorkspace: noop,
    activateTabByPath,
    startDraftInWorkspace: noop,
    startNewTaskFromActiveWorkspace: noop,
    openWorkspace: noop,
    openWorkspacePath,
    setWorkspaceActionError: noop,
    allowOpenWorkspace: allowed,
  });
  return (
    <output data-testid="root-events-locale" data-version={version} data-allowed={String(allowed)}>
      {locale}
    </output>
  );
}
export function RootEventsProbe({ platform }: { platform: IPlatformService }) {
  const [version, setVersion] = useState(0);
  const [allowed, setAllowed] = useState(true);
  const [mounted, setMounted] = useState(true);
  rootEventsFixture.setVersion = setVersion;
  rootEventsFixture.setAllowed = setAllowed;
  rootEventsFixture.unmount = () => setMounted(false);
  return mounted ? <Effects platform={platform} version={version} allowed={allowed} /> : null;
}
