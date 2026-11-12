import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { ReactNode } from "react";
import type { Locale, LocalePreference } from "@zcode/shared";
import { DEFAULT_LOCALE } from "@zcode/shared";
import type { BroadcastMessage, IBroadcastService, ISettingService } from "@zcode/services";
import {
  readNavigatorLanguage,
  readSafeLocalStorage,
  writeSafeLocalStorage,
} from "@/lib/browserEnvironment.js";
import zhCN from "./locales/zh-CN.js";
import enUS from "./locales/en-US.js";

/** 语言 → 翻译消息映射 */
const MESSAGES: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

/** 简易 intl 工具：根据 id 查找翻译，支持 {key} 占位符替换 */
export interface IntlInstance {
  formatMessage(descriptor: { id: string }, values?: Record<string, string | number>): string;
}

const LOCALE_PREFERENCE_KEY = "zcode-locale-preference";
const STATE_LOCALE_CHANNEL = "state:locale";

interface LocaleBroadcastPayload {
  preference: LocalePreference;
  resolvedLocale: Locale;
}

function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en-US";
}

function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || isLocale(value);
}

function resolveLocaleBroadcastPayload(payload: unknown): LocaleBroadcastPayload | null {
  if (isLocale(payload)) {
    return {
      preference: payload,
      resolvedLocale: payload,
    };
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Partial<LocaleBroadcastPayload>;
  if (isLocalePreference(candidate.preference) && isLocale(candidate.resolvedLocale)) {
    return {
      preference: candidate.preference,
      resolvedLocale: candidate.resolvedLocale,
    };
  }

  return null;
}

export function resolveLocalePreferenceFromSettings({
  storedPreference,
  settingsLocale,
  settingsLocalePreference,
  preferSettingServiceLocale,
  hasHostSystemLocaleResolver = false,
}: {
  storedPreference: LocalePreference | null;
  settingsLocale: Locale | undefined;
  settingsLocalePreference: LocalePreference | undefined;
  preferSettingServiceLocale: boolean;
  hasHostSystemLocaleResolver?: boolean;
}): LocalePreference | null {
  // 原因：远控必须保留宿主的 system 偏好，才能在重挂后重新解析真实系统语言。
  // 没有宿主解析器的旧入口仍使用已解析的 locale，保持原有兼容契约。
  if (
    preferSettingServiceLocale &&
    settingsLocalePreference === "system" &&
    hasHostSystemLocaleResolver
  ) {
    return "system";
  }
  if (preferSettingServiceLocale && settingsLocale) {
    return settingsLocale;
  }

  return storedPreference ?? settingsLocalePreference ?? settingsLocale ?? null;
}

export function shouldApplyLocaleBroadcastMessage(
  message: Pick<BroadcastMessage, "channel" | "payload" | "sourceWindowId">,
  options: {
    ignoredLocalPayload?: LocaleBroadcastPayload | null;
  } = {},
): message is Pick<BroadcastMessage, "channel"> & { payload: Locale | LocaleBroadcastPayload } {
  const payload = resolveLocaleBroadcastPayload(message.payload);
  if (message.channel !== STATE_LOCALE_CHANNEL || !payload) {
    return false;
  }
  if (
    message.sourceWindowId === undefined &&
    options.ignoredLocalPayload?.preference === payload.preference &&
    options.ignoredLocalPayload.resolvedLocale === payload.resolvedLocale
  ) {
    return false;
  }
  return true;
}

function createIntl(locale: Locale): IntlInstance {
  // noUncheckedIndexedAccess：用 ?? 回退到默认语言的翻译
  const messages = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE]!;
  return {
    formatMessage({ id }, values) {
      let msg = messages[id] ?? id;
      if (values) {
        for (const [key, val] of Object.entries(values)) {
          msg = msg.replaceAll(`{${key}}`, String(val));
        }
      }
      return msg;
    },
  };
}

interface IntlContextValue {
  intl: IntlInstance;
  locale: Locale;
  localePreference: LocalePreference;
  setLocale: (locale: Locale) => void;
  setLocalePreference: (localePreference: LocalePreference) => void;
}

const IntlContext = createContext<IntlContextValue | null>(null);

/**
 * 国际化 Provider —— 管理当前语言和 intl 实例。
 * 如果传入 settingService，会从设置中读取初始语言并在切换时持久化。
 */
export function ZCodeIntlProvider({
  children,
  settingService,
  broadcastService,
  initialLocale,
  preferSettingServiceLocale = false,
  resolveSystemLocale: resolveHostSystemLocale,
}: {
  children: ReactNode;
  settingService?: ISettingService;
  broadcastService?: Pick<IBroadcastService, "send" | "onMessage">;
  initialLocale?: Locale;
  preferSettingServiceLocale?: boolean;
  resolveSystemLocale?: () => Locale | Promise<Locale>;
}) {
  const applyingBroadcastRef = useRef(false);
  const ignoredLocalLocaleBroadcastPayloadRef = useRef<LocaleBroadcastPayload | null>(null);
  const localePreferenceOperationSeqRef = useRef(0);
  const resolveNavigatorSystemLocale = useCallback((): Locale => {
    const language = readNavigatorLanguage();
    if (!language) {
      return DEFAULT_LOCALE;
    }

    return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  }, []);
  const resolveSystemLocale = useCallback(async (): Promise<Locale> => {
    const resolvedLocale = await resolveHostSystemLocale?.();
    if (isLocale(resolvedLocale)) {
      return resolvedLocale;
    }
    return resolveNavigatorSystemLocale();
  }, [resolveHostSystemLocale, resolveNavigatorSystemLocale]);

  useEffect(
    () => () => {
      // 原因：同一个 Provider 的依赖换代或卸载后，旧系统语言请求不能再写设置或广播。
      // 复用语言操作序号，避免依赖桥接销毁来判断仍可共享的宿主服务是否有效。
      localePreferenceOperationSeqRef.current += 1;
      ignoredLocalLocaleBroadcastPayloadRef.current = null;
    },
    [settingService, broadcastService, resolveSystemLocale],
  );

  const readStoredPreference = useCallback((): LocalePreference | null => {
    const raw = readSafeLocalStorage(LOCALE_PREFERENCE_KEY);
    if (isLocalePreference(raw)) {
      return raw;
    }
    return null;
  }, []);

  const persistLocalePreference = useCallback((preference: LocalePreference) => {
    writeSafeLocalStorage(LOCALE_PREFERENCE_KEY, preference);
  }, []);

  const [localePreference, setLocalePreferenceState] = useState<LocalePreference>(
    () => initialLocale ?? readStoredPreference() ?? "system",
  );
  const [systemLocale, setSystemLocale] = useState<Locale>(() => resolveNavigatorSystemLocale());
  const enqueueLocalePreferenceUpdate = useCallback(
    (operationSeq: number, resolvedLocale: Locale, preference: LocalePreference) => {
      if (localePreferenceOperationSeqRef.current !== operationSeq) {
        return;
      }

      // Provider 层不能把持久化 RPC 串成无界等待链。
      // 一次 settingService.update 永久 pending 时，后续语言选择仍要继续尝试落盘；
      // 底层 settingService 负责文件写入顺序，这里只做最新操作校验和错误收口。
      void settingService
        ?.update({
          locale: resolvedLocale,
          localePreference: preference,
        })
        .catch(() => {
          // 持久化失败不阻断 UI 状态和跨窗口广播，下一次语言操作会再次尝试写入。
        });
    },
    [settingService],
  );

  // 从 settingService 读取持久化的 locale
  useEffect(() => {
    if (!settingService) return;
    let disposed = false;
    const initialOperationSeq = localePreferenceOperationSeqRef.current;
    settingService
      .get()
      .then(async (settings) => {
        if (disposed || localePreferenceOperationSeqRef.current !== initialOperationSeq) {
          return;
        }
        const nextPreference = resolveLocalePreferenceFromSettings({
          storedPreference: readStoredPreference(),
          settingsLocale: settings.locale,
          settingsLocalePreference: settings.localePreference,
          preferSettingServiceLocale,
          hasHostSystemLocaleResolver: Boolean(resolveHostSystemLocale),
        });
        if (disposed) {
          return;
        }
        if (nextPreference) {
          // 手机远控和桌面连接到同一个 settingService，但手机浏览器本地可能残留
          // en-US/system 偏好。远控入口必须以桌面 setting.json 为准，否则会出现桌面中文、手机英文。
          setLocalePreferenceState(nextPreference);
          if (preferSettingServiceLocale) {
            persistLocalePreference(nextPreference);
          }
          if (nextPreference === "system") {
            // 已持久化的宿主 locale 只用于加载显示；必须等实时解析成功才允许回写。
            if (isLocale(settings.locale)) {
              setSystemLocale(settings.locale);
            }
            const resolvedLocale = await resolveSystemLocale();
            if (disposed || localePreferenceOperationSeqRef.current !== initialOperationSeq) {
              return;
            }
            setSystemLocale(resolvedLocale);
            if (settings.locale !== resolvedLocale) {
              // setting.json 里的 locale 是 main 进程菜单、远控等非浏览器上下文的实际语言。
              // system 模式必须使用宿主系统语言；Electron renderer 的 navigator.language 可能和
              // macOS app.getLocale() 不一致，直接写回会把中文系统错误持久化成英文。
              enqueueLocalePreferenceUpdate(initialOperationSeq, resolvedLocale, "system");
            }
          }
        }
      })
      .catch(() => {
        // 读取设置或宿主解析失败时结束本次初始化，不把手机浏览器语言回写给桌面。
        // 后续显式选择使用新的操作序号，仍可继续持久化。
      });
    return () => {
      disposed = true;
    };
  }, [
    persistLocalePreference,
    preferSettingServiceLocale,
    readStoredPreference,
    enqueueLocalePreferenceUpdate,
    resolveHostSystemLocale,
    resolveSystemLocale,
    settingService,
  ]);

  const locale = useMemo<Locale>(() => {
    return localePreference === "system" ? systemLocale : localePreference;
  }, [localePreference, systemLocale]);

  const setLocalePreference = useCallback(
    (newPreference: LocalePreference) => {
      const operationSeq = localePreferenceOperationSeqRef.current + 1;
      localePreferenceOperationSeqRef.current = operationSeq;
      setLocalePreferenceState(newPreference);
      persistLocalePreference(newPreference);
      void (async () => {
        const resolvedLocale =
          newPreference === "system" ? await resolveSystemLocale() : newPreference;
        if (localePreferenceOperationSeqRef.current !== operationSeq) {
          return;
        }
        if (newPreference === "system") {
          setSystemLocale(resolvedLocale);
        }
        const broadcastPayload: LocaleBroadcastPayload = {
          preference: newPreference,
          resolvedLocale,
        };
        if (!applyingBroadcastRef.current && broadcastService) {
          // 跨窗口语言同步不能等待 settingService 持久化 RPC。
          // 持久化可能超时或拒绝，但本地 UI 与其他窗口应先按用户最后一次选择同步。
          ignoredLocalLocaleBroadcastPayloadRef.current = broadcastPayload;
          void broadcastService
            .send({
              channel: STATE_LOCALE_CHANNEL,
              payload: broadcastPayload,
            })
            .finally(() => {
              if (ignoredLocalLocaleBroadcastPayloadRef.current === broadcastPayload) {
                ignoredLocalLocaleBroadcastPayloadRef.current = null;
              }
            })
            .catch(() => {
              // 广播拒绝不能成为未处理异常，也不能阻止当前有效选择写入宿主设置。
            });
        }
        enqueueLocalePreferenceUpdate(operationSeq, resolvedLocale, newPreference);
      })().catch(() => {
        // 宿主解析或旧槽租约拒绝时收口，不降级到手机语言；下一次选择可独立继续。
      });
    },
    [broadcastService, enqueueLocalePreferenceUpdate, persistLocalePreference, resolveSystemLocale],
  );

  useEffect(() => {
    if (!broadcastService) {
      return;
    }

    const subscription = broadcastService.onMessage((message) => {
      if (
        !shouldApplyLocaleBroadcastMessage(message, {
          ignoredLocalPayload: ignoredLocalLocaleBroadcastPayloadRef.current,
        })
      ) {
        return;
      }

      ignoredLocalLocaleBroadcastPayloadRef.current = null;
      const payload = resolveLocaleBroadcastPayload(message.payload);
      if (!payload) {
        return;
      }
      applyingBroadcastRef.current = true;
      try {
        // 语言切换真实发生在 IntlProvider，不能只依赖 store 里的 locale 字段。
        // 结构化广播需要同时携带用户偏好和解析语言，避免 system 被其他窗口降级成固定语言。
        localePreferenceOperationSeqRef.current += 1;
        setLocalePreferenceState(payload.preference);
        persistLocalePreference(payload.preference);
        setSystemLocale(payload.resolvedLocale);
      } finally {
        applyingBroadcastRef.current = false;
      }
    });

    return () => subscription.dispose();
  }, [broadcastService, persistLocalePreference]);

  const setLocale = useCallback(
    (newLocale: Locale) => {
      setLocalePreference(newLocale);
    },
    [setLocalePreference],
  );

  const intl = useMemo(() => createIntl(locale), [locale]);

  const value = useMemo<IntlContextValue>(
    () => ({ intl, locale, localePreference, setLocale, setLocalePreference }),
    [intl, locale, localePreference, setLocale, setLocalePreference],
  );

  return <IntlContext value={value}>{children}</IntlContext>;
}

/** 获取 intl 上下文 */
export function useZCodeIntl(): IntlContextValue {
  const ctx = useContext(IntlContext);
  if (!ctx) {
    throw new Error("useZCodeIntl 必须在 ZCodeIntlProvider 内使用");
  }
  return ctx;
}
