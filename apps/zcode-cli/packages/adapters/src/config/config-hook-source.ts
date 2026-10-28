import type { HookConfigSource, RuntimeConfigPatch } from "@zcode/contracts";

export function withHookConfigSource(
  config: RuntimeConfigPatch,
  source: HookConfigSource,
): RuntimeConfigPatch {
  if (!config.hooks?.events) return config;
  return {
    ...config,
    hooks: {
      ...config.hooks,
      events: Object.fromEntries(
        Object.entries(config.hooks.events).map(([eventName, matchers]) => [
          eventName,
          matchers?.map((matcher) => ({
            ...matcher,
            hooks: matcher.hooks.map((hook) => ({ ...hook, source: hook.source ?? source })),
          })),
        ]),
      ) as NonNullable<RuntimeConfigPatch["hooks"]>["events"],
    },
  };
}
