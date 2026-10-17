import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppSettings, IPlatformService } from "@zcode/shared";
import type { ISettingService, IServiceAccessor } from "@zcode/services";
import { useSettings } from "@/hooks/useSettingService.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";

interface SettingsServiceHarness {
  calls: number;
  service: ISettingService;
}

interface PlatformHarness {
  registrations: number;
  callbackCalls: number;
  synchronousRegistrationCallback: boolean;
  listeners: Set<() => void>;
  platform: IPlatformService;
}

interface ConsumerRoot {
  root: Root;
  host: HTMLDivElement;
  settingServiceId: string;
  platformId: string;
}

declare global {
  interface Window {
    performanceRound13Settings: {
      mount(
        name: string,
        settingServiceId: string,
        platformId: string,
        strictMode?: boolean,
      ): Promise<void>;
      unmount(name: string): Promise<void>;
      fire(platformId: string): Promise<void>;
      setSynchronousRegistrationCallback(platformId: string, enabled: boolean): void;
      snapshot(): {
        services: Record<string, { calls: number }>;
        platforms: Record<string, { registrations: number; active: number; callbackCalls: number }>;
        consumers: string[];
      };
    };
  }
}

const services = new Map<string, SettingsServiceHarness>();
const platforms = new Map<string, PlatformHarness>();
const consumers = new Map<string, ConsumerRoot>();

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function getSettingsService(id: string): SettingsServiceHarness {
  const existing = services.get(id);
  if (existing) return existing;
  const harness = { calls: 0 } as SettingsServiceHarness;
  harness.service = {
    get: async () => {
      harness.calls += 1;
      return { theme: "dark" } as AppSettings;
    },
    update: async () => undefined,
  } as ISettingService;
  services.set(id, harness);
  return harness;
}

function getPlatform(id: string): PlatformHarness {
  const existing = platforms.get(id);
  if (existing) return existing;
  const harness: PlatformHarness = {
    registrations: 0,
    callbackCalls: 0,
    synchronousRegistrationCallback: false,
    listeners: new Set(),
    platform: {} as IPlatformService,
  };
  harness.platform = {
    onSettingsChanged: (callback) => {
      harness.registrations += 1;
      harness.listeners.add(callback);
      if (harness.synchronousRegistrationCallback) {
        harness.callbackCalls += 1;
        callback();
      }
      return () => harness.listeners.delete(callback);
    },
  } as IPlatformService;
  platforms.set(id, harness);
  return harness;
}

function SettingsConsumer({ name }: { name: string }) {
  const { settings, loading, error } = useSettings();
  return createElement("output", {
    id: `consumer-${name}`,
    "data-loading": String(loading),
    "data-theme": settings?.theme ?? "",
    "data-error": error ? String(error) : "",
  });
}

async function mount(
  name: string,
  settingServiceId: string,
  platformId: string,
  strictMode = false,
): Promise<void> {
  const previous = consumers.get(name);
  if (previous) await unmount(name);

  const settingHarness = getSettingsService(settingServiceId);
  const platformHarness = getPlatform(platformId);
  const host = document.createElement("div");
  host.dataset.consumer = name;
  document.querySelector("#root")?.append(host);
  const root = createRoot(host);
  consumers.set(name, { root, host, settingServiceId, platformId });
  const providerTree = createElement(
    ServiceProvider,
    {
      services: {
        settingService: settingHarness.service,
        botsService: { syncAppRuntimePreferences: async () => undefined },
        broadcastService: { send: async () => undefined },
        zcodeAgentService: { syncAppRuntimePreferences: async () => undefined },
      } as unknown as IServiceAccessor,
    },
    createElement(
      PlatformProvider,
      { platform: platformHarness.platform },
      createElement(SettingsConsumer, { name }),
    ),
  );
  await act(async () => {
    root.render(strictMode ? createElement(StrictMode, null, providerTree) : providerTree);
  });
}

async function unmount(name: string): Promise<void> {
  const consumer = consumers.get(name);
  if (!consumer) return;
  consumers.delete(name);
  await act(async () => consumer.root.unmount());
  consumer.host.remove();
}

window.performanceRound13Settings = {
  mount,
  unmount,
  async fire(platformId) {
    const harness = platforms.get(platformId);
    if (!harness) return;
    await act(async () => {
      for (const listener of harness.listeners) {
        harness.callbackCalls += 1;
        listener();
      }
      await Promise.resolve();
      await Promise.resolve();
    });
  },
  setSynchronousRegistrationCallback(platformId, enabled) {
    getPlatform(platformId).synchronousRegistrationCallback = enabled;
  },
  snapshot() {
    return {
      services: Object.fromEntries(
        [...services].map(([id, harness]) => [id, { calls: harness.calls }]),
      ),
      platforms: Object.fromEntries(
        [...platforms].map(([id, harness]) => [
          id,
          {
            registrations: harness.registrations,
            active: harness.listeners.size,
            callbackCalls: harness.callbackCalls,
          },
        ]),
      ),
      consumers: [...consumers.keys()],
    };
  },
};
