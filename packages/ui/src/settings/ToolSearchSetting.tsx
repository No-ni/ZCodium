import { appToolSearchModeSchema, type AppToolSearchMode } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { SettingsBadge, SettingsRow } from "@/settings/SettingsPageParts.js";

const MODES = ["off", "auto", "local"] as const;

export function ToolSearchSetting({
  mode = "off",
  onModeChange,
}: {
  mode?: AppToolSearchMode;
  onModeChange: (mode: AppToolSearchMode) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "settings.toolSearch" });
  return (
    <SettingsRow
      controlLayout="wide"
      label={
        <span className="flex flex-wrap items-center gap-2">
          {label}
          <SettingsBadge>{intl.formatMessage({ id: "settings.experimental" })}</SettingsBadge>
        </span>
      }
      description={intl.formatMessage({ id: "settings.toolSearchDescription" })}
      control={
        <Select
          value={mode}
          onValueChange={(value) => {
            const parsed = appToolSearchModeSchema.safeParse(value);
            if (parsed.success) void onModeChange(parsed.data);
          }}
        >
          <SelectTrigger
            size="lg"
            className="w-full min-w-0 justify-between"
            aria-label={label}
            data-testid="settings-tool-search-mode"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((value) => (
              <SelectItem key={value} value={value} data-testid={`settings-tool-search-${value}`}>
                {intl.formatMessage({ id: `settings.toolSearch.${value}` })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}
