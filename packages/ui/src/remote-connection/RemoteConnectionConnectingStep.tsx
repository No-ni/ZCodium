import { useCallback, useEffect, useRef } from "react";
import { RemotePasswordInput } from "@/remote-connection/RemotePasswordInput.js";
import { classifyRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { resolveRemoteConnectionPhases } from "@/remote-connection-flow/connectionPhases.js";
export {
  resolveRemoteConnectionPhases,
  resolveRemoteOperationProgress,
} from "@/remote-connection-flow/connectionPhases.js";
import { AlertTriangleIcon, LoaderIcon } from "lucide-react";
import { TID_SSH_ERROR } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  isRemoteConnectionLogScrolledToLatest,
  scrollRemoteConnectionLogsToLatestIfFollowing,
} from "@/remote-connection/remoteConnectionLogScroll.js";

export function RemoteConnectionConnectingStep({
  logs,
  errorMessage,
  loading,
  onBack,
  onRetry,
  errorCode,
  rawError,
  cancelled,
  credentials,
  connectionReady,
  workspacePath,
  recognizedDeviceName,
  profileName,
  recognizedDeviceMeta,
  onContinueToDirectory,
  onCancelConnection,
  onMinimize,
  onClose,
  onBackToDevices,
  backToDevicesLabel,
}: {
  logs: RemoteConnectionLogEntry[];
  errorMessage: string;
  loading: boolean;
  onBack: () => void;
  onRetry: () => void;
  errorCode?: string;
  rawError?: string;
  cancelled?: boolean;
  credentials?: {
    passphrase: boolean;
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
  };
  connectionReady?: boolean;
  workspacePath?: string;
  recognizedDeviceName?: string;
  profileName?: string;
  recognizedDeviceMeta?: string;
  onContinueToDirectory?: () => void;
  onCancelConnection?: () => void;
  onMinimize?: () => void;
  onClose?: () => void;
  onBackToDevices?: () => void;
  backToDevicesLabel?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowLatestLogRef = useRef(true);
  const latestLogId = logs.at(-1)?.id;
  const latestLogTimestamp = logs.at(-1)?.timestamp;
  const phases = resolveRemoteConnectionPhases(logs, {
    connectionReady: !errorMessage && connectionReady,
    includeWorkspace: Boolean(workspacePath),
  });
  const failure = classifyRemoteConnectionError({ errorCode, error: rawError ?? errorMessage });
  const manualActionRequired = [
    "source-server-install-required",
    "source-server-upgrade-required",
  ].includes(errorCode ?? "");

  const handleLogContainerScroll = useCallback(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    shouldFollowLatestLogRef.current = isRemoteConnectionLogScrolledToLatest(container);
  }, []);

  useEffect(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    // 日志持续追加会推高 scrollHeight，无条件写 scrollTop 会把向上查看历史日志的用户拉回底部。
    // 这里只在用户原本贴底时继续跟随最新日志。
    if (
      scrollRemoteConnectionLogsToLatestIfFollowing(container, shouldFollowLatestLogRef.current)
    ) {
      shouldFollowLatestLogRef.current = true;
    }
  }, [logs.length, latestLogId, latestLogTimestamp]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 h-full">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-words text-ui-base font-medium">
          {recognizedDeviceName ?? profileName}
        </p>
        <div className="flex gap-2">
          {onMinimize ? (
            <Button variant="ghost" size="sm" onClick={onMinimize}>
              {intl.formatMessage({ id: "remote.continueInBackground" })}
            </Button>
          ) : null}
          {onClose ? (
            <Button variant="ghost" size="sm" onClick={onClose}>
              {intl.formatMessage({ id: "common.close" })}
            </Button>
          ) : null}
        </div>
      </div>
      {recognizedDeviceMeta ? (
        <p className="text-ui-sm text-foreground-subtle">{recognizedDeviceMeta}</p>
      ) : null}
      <ol
        className="flex flex-wrap gap-3 text-ui-sm"
        aria-label={intl.formatMessage({ id: "remote.connecting" })}
      >
        {phases.map((phase) => (
          <li
            key={phase.key}
            data-phase={phase.key}
            data-phase-status={phase.status}
            aria-current={phase.status === "active" ? "step" : undefined}
            className={cn(
              "rounded-lg border border-border px-3 py-2",
              phase.status === "failed"
                ? "text-destructive"
                : phase.status === "complete"
                  ? "text-success"
                  : "text-foreground-subtle",
            )}
          >
            {intl.formatMessage({ id: phase.titleId })}
          </li>
        ))}
      </ol>
      {cancelled ? (
        <p role="status">{intl.formatMessage({ id: "remote.connectionCancelled" })}</p>
      ) : null}
      {credentials ? (
        <form
          className="space-y-3 rounded-lg border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!loading && credentials.value) credentials.onSubmit();
          }}
        >
          <label className="block text-ui-sm">
            {intl.formatMessage({
              id: credentials.passphrase ? "ssh.privateKeyPassphrase" : "ssh.password",
            })}
            <RemotePasswordInput
              data-testid="remote-connection-credential"
              value={credentials.value}
              disabled={loading}
              autoComplete="off"
              onChange={(event) => credentials.onChange(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={loading || !credentials.value}>
            {intl.formatMessage({ id: "remote.retryConnection" })}
          </Button>
        </form>
      ) : null}
      <div className="flex flex-col flex-1 min-h-0 space-y-4">
        <div className="min-h-0 flex-1 flex flex-col rounded-xl bg-background border border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "remote.connectionLog" })}
            </p>
            {loading ? (
              <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
                <LoaderIcon className="size-3.5 animate-spin" />
                {intl.formatMessage({ id: "remote.connecting" })}
              </div>
            ) : null}
          </div>
          <div
            ref={logContainerRef}
            onScroll={handleLogContainerScroll}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 font-mono text-ui-base"
          >
            {logs.length > 0 ? (
              logs.map((entry) => (
                <div key={entry.id} className="w-full flex min-w-0 leading-5 text-foreground">
                  <span className="text-foreground-subtlest">{entry.timestamp}</span>
                  <span
                    className={cn(
                      "mx-2",
                      entry.level === "success"
                        ? "text-success"
                        : entry.level === "warn"
                          ? "text-warning"
                          : entry.level === "error"
                            ? "text-destructive"
                            : "text-foreground-subtle",
                    )}
                  >
                    [{entry.level.toUpperCase()}]
                  </span>
                  <span>{entry.message}</span>
                </div>
              ))
            ) : (
              <div className="flex min-h-full items-center justify-center text-foreground-subtle">
                <span>[INFO] {intl.formatMessage({ id: "remote.connectionLogEmpty" })}</span>
              </div>
            )}
          </div>
        </div>

        {errorMessage ? (
          <div
            data-testid={TID_SSH_ERROR}
            className="flex flex-wrap items-start gap-3 rounded-xl border border-warning/30 px-4 py-3 text-ui-base text-warning"
          >
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1 break-words">
              {errorMessage}
              {manualActionRequired ? (
                <p className="mt-1">{intl.formatMessage({ id: failure.reasonId })}</p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void platform.openFeedback();
              }}
              className="h-7 shrink-0 border-warning/30 text-warning hover:bg-warning/10"
            >
              {intl.formatMessage({ id: "remoteConnection.feedback" })}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap justify-end gap-3">
        {onBackToDevices ? (
          <Button variant="secondary" disabled={loading} onClick={onBackToDevices}>
            {backToDevicesLabel ?? intl.formatMessage({ id: "remote.selection.back" })}
          </Button>
        ) : null}
        {loading && onCancelConnection ? (
          <Button
            data-testid="remote-connection-cancel"
            variant="secondary"
            onClick={onCancelConnection}
          >
            {intl.formatMessage({ id: "remote.cancelConnection" })}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-10 min-w-0 px-5"
          onClick={onBack}
          disabled={loading}
        >
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        {connectionReady && onContinueToDirectory ? (
          <Button data-testid="remote-connection-continue" onClick={onContinueToDirectory}>
            {intl.formatMessage({ id: "remote.selectDirectoryTitle" })}
          </Button>
        ) : null}
        {!connectionReady && !manualActionRequired && !credentials ? (
          <Button
            type="button"
            size="lg"
            className="h-10 min-w-0 px-5"
            onClick={onRetry}
            disabled={loading}
          >
            {loading
              ? intl.formatMessage({ id: "remote.connecting" })
              : intl.formatMessage({
                  id:
                    errorCode === "source-server-identity-change-pending"
                      ? "remote.action.confirm-identity"
                      : "remote.retryConnection",
                })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
