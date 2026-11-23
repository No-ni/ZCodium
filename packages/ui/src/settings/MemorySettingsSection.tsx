import { useCallback, useMemo, useState } from "react";
import { type IServiceAccessor } from "@zcode/services";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useSettings, updateSettingsAndRefreshSnapshot } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";
import {
  SettingsScopeBlockedNotice,
  resolveSettingsScopeBlock,
  useSettingsScope,
  type SettingsScopeDevice,
} from "@/settings-scope/index.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import { MemorySettingsSection } from "./MemoryCatalogSettings.js";
export { MemorySettingsSection } from "./MemoryCatalogSettings.js";

interface MemorySettingsPageProps {
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  isDesktop: boolean;
  workspaceDisplayNames: readonly string[];
}

const LOCAL_MEMORY_DEVICE = { kind: "local" } as const;

export function MemorySettingsPage(props: MemorySettingsPageProps) {
  const services = useBaseWorkspaceServices();
  // 手机保留当前 Host 的入口，不挂载桌面设备目录或申请 source-settings attachment。
  if (props.isDesktop) return <DesktopMemorySettingsPage {...props} />;
  return (
    <ServiceProvider services={services}>
      <MemoryDeviceSettings
        services={services}
        device={LOCAL_MEMORY_DEVICE}
        isDesktop={false}
        workspaceDisplayNames={props.workspaceDisplayNames}
      />
    </ServiceProvider>
  );
}

/** 设备选择与其他配置页同源；开关属于设备，不提供项目级选项。 */
function DesktopMemorySettingsPage({
  workspacePath,
  workspaceIdentity,
  isDesktop,
  workspaceDisplayNames,
}: MemorySettingsPageProps) {
  const scope = useSettingsScope({ workspacePath, workspaceIdentity });
  const groups = useMemo(
    () =>
      scope.groups
        .map((group) => ({
          ...group,
          options: group.options.filter((option) => option.kind === "user"),
        }))
        .filter((group) => group.options.length > 0),
    [scope.groups],
  );
  const blocked = resolveSettingsScopeBlock(scope, true);
  const user = scope.user.status === "ready" ? scope.user : null;

  return (
    <div className="space-y-6">
      {isDesktop ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <PluginScopeMenu
            groups={groups}
            selectedScopeKey={scope.selectedScopeKey}
            selectedDevice={scope.device}
            triggerTestId="settings-memory-device-trigger"
            onScopeKeyChange={scope.setSelectedScopeKey}
          />
        </div>
      ) : null}
      {blocked ? (
        <SettingsScopeBlockedNotice state={blocked} device={scope.device} />
      ) : user ? (
        // 切换设备时卸载旧投影，防止旧开关、保存错误和 catalog 短暂显示在新设备下。
        <ServiceProvider services={user.unscopedServices} key={scope.selectedScopeKey}>
          <MemoryDeviceSettings
            services={user.unscopedServices}
            device={scope.device}
            isDesktop={isDesktop}
            workspaceDisplayNames={workspaceDisplayNames}
          />
        </ServiceProvider>
      ) : null}
    </div>
  );
}

function MemoryDeviceSettings({
  services,
  device,
  isDesktop,
  workspaceDisplayNames,
}: {
  services: IServiceAccessor;
  device: SettingsScopeDevice;
  isDesktop: boolean;
  workspaceDisplayNames: readonly string[];
}) {
  const { intl } = useZCodeIntl();
  const { settings, loading, error, refresh } = useSettings({ services });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const isLocal = device.kind === "local";
  const onMemoryEnabledChange = useCallback(
    async (enabled: boolean) => {
      setSaving(true);
      setSaveError(null);
      try {
        // 保存绑定所选设备服务，不能回落本机或写入官方账户。
        await updateSettingsAndRefreshSnapshot({
          settingService: services.settingService,
          patch: { memoryEnabled: enabled },
        });
        if (isLocal) {
          await services.onboardingRecordService
            ?.updateRecordPreferences({ memoryEnabled: enabled })
            .catch(() => logger.warn("[memory-settings] 回写本地引导记录失败"));
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setSaveError(message);
        logger.warn("[memory-settings] 保存设备记忆开关失败", { local: isLocal });
      } finally {
        setSaving(false);
      }
    },
    [isLocal, services],
  );
  const readError = error instanceof Error ? error.message : error ? String(error) : null;

  return (
    <div className="space-y-6">
      {readError || saveError ? (
        <Alert data-testid="settings-memory-error">
          <AlertDescription>{readError || saveError}</AlertDescription>
          {readError ? (
            <Button variant="outline" onClick={() => void refresh()}>
              {intl.formatMessage({ id: "common.retry" })}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {!settings && !readError ? (
        <SettingsScopeBlockedNotice state="connecting" device={device} />
      ) : settings ? (
        <MemorySettingsSection
          memoryEnabled={settings.memoryEnabled === true}
          memoryService={services.memoryService}
          onMemoryEnabledChange={onMemoryEnabledChange}
          summaryModelSelection={settings.summaryModelSelection ?? null}
          onSummaryModelChange={(selection) =>
            updateSettingsAndRefreshSnapshot({
              settingService: services.settingService,
              patch: { summaryModelSelection: selection },
            })
          }
          disabled={loading || saving || Boolean(readError)}
          projectMemoryViewerAvailable={isDesktop && isLocal}
          remoteDevice={!isLocal}
          workspaceDisplayNames={workspaceDisplayNames}
        />
      ) : null}
    </div>
  );
}
