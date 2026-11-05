import { TID_V4_RETRY_SUBSCRIBE } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface SessionSubscriptionErrorPanelProps {
  error: string;
  onReconnect: () => void;
  reconnectLabel?: string;
}

export function SessionSubscriptionErrorPanel({
  error,
  onReconnect,
  reconnectLabel,
}: SessionSubscriptionErrorPanelProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-ui-base">
      <p className="max-w-full break-words text-center font-mono text-destructive">{error}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" variant="outline" onClick={() => void platform.openFeedback()}>
          {intl.formatMessage({ id: "chat.error.feedback" })}
        </Button>
        <Button type="button" data-testid={TID_V4_RETRY_SUBSCRIBE} onClick={onReconnect}>
          {reconnectLabel ?? intl.formatMessage({ id: "workspaceSidebar.reconnect" })}
        </Button>
      </div>
    </div>
  );
}
