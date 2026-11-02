import { useEffect, useRef, useState } from "react";
import {
  compareSemverVersions,
  sourceServerRunningTasksResultSchema,
  type ConnectionProfile,
  type SourceServerRunningTasksResult,
} from "@zcode/shared";
import { ProfileEditor } from "./SourceServerProfileEditor.js";
import { useSourceServerManagement } from "@/hooks/useSourceServerManagement.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";

type PendingConfirmation =
  | { kind: "mirror"; profile: ConnectionProfile }
  | { kind: "identity"; profile: ConnectionProfile; expectedSourceServerId: string }
  | { kind: "remove"; profile: ConnectionProfile }
  | { kind: "stop"; profile: ConnectionProfile; runningTasks: SourceServerRunningTasksResult }
  | { kind: "restart"; profile: ConnectionProfile; runningTasks: SourceServerRunningTasksResult };

export function SourceServerSettingsSection() {
  const { intl } = useZCodeIntl();
  const { service, state, refresh } = useSourceServerManagement();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const admission = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    admission.current = false;
    setBusy(false);
    setConfirmation(null);
    return () => {
      generation.current++;
    };
  }, [service]);
  const run = async <T,>(operation: () => Promise<T>, completed?: (result: T) => void) => {
    if (admission.current || !service || serviceRef.current !== service) return;
    admission.current = true;
    const current = generation.current;
    const active = () => current === generation.current && serviceRef.current === service;
    setBusy(true);
    setError(false);
    try {
      const result = await operation();
      if (!active()) return;
      await refresh();
      if (!active()) return;
      setConfirmation(null);
      completed?.(result);
    } catch {
      if (active()) setError(true);
    } finally {
      if (active()) {
        admission.current = false;
        setBusy(false);
      }
    }
  };
  const text = (id: string) => intl.formatMessage({ id });
  const lifecycleDescription =
    confirmation && "runningTasks" in confirmation
      ? [
          text("settings.source.remoteServiceInterruptionDescription"),
          !confirmation.runningTasks.available
            ? text("settings.source.remoteServiceRunningTasksUnavailable")
            : confirmation.runningTasks.tasks.length
              ? confirmation.runningTasks.tasks
                  .map((task) => task.sessionId + " — " + task.workspacePath)
                  .join("\n")
              : text("settings.source.remoteServiceNoRunningTasks"),
          text("settings.source.remoteServiceOtherClientsNotice"),
        ].join("\n\n")
      : undefined;
  if (state.status !== "ready" || !service)
    return (
      <div className="space-y-3">
        <p className="text-ui-sm text-foreground-subtle">
          {text(state.status === "loading" ? "common.loading" : "sourceServer.unavailable")}
        </p>
        <Button variant="secondary" onClick={() => void refresh()}>
          {text("sourceServer.refresh")}
        </Button>
      </div>
    );
  return (
    <div className="min-w-0 space-y-4">
      <p className="text-ui-sm text-foreground-subtle">{text("sourceServer.description")}</p>
      <Button variant="secondary" onClick={() => void refresh()} disabled={busy}>
        {text("sourceServer.refresh")}
      </Button>
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {text("sourceServer.operationFailed")}
        </p>
      ) : null}
      {state.snapshot.directory.profiles.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtle">{text("sourceServer.empty")}</p>
      ) : (
        state.snapshot.directory.profiles.map((profile) => {
          const connection = state.snapshot.states.find(
            (entry) =>
              entry.profileId === profile.profileId && entry.generation === profile.generation,
          );
          const server = state.snapshot.directory.servers.find(
            (item) => item.sourceServerId === profile.sourceServerId,
          );
          const supported = server ? compareSemverVersions(server.version, "3.17.1") : null;
          const lifecycleEnabled =
            supported !== null &&
            supported >= 0 &&
            connection?.state !== "connecting" &&
            !["needs-install", "needs-start", "needs-upgrade", "identity-change-pending"].includes(
              connection?.state ?? "",
            );
          return (
            <section
              key={`${profile.profileId}:${profile.generation}`}
              className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-3"
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <h3 className="min-w-0 break-words text-ui-base font-medium">
                  {profile.displayName}
                </h3>
                <span role="status" className="text-ui-sm text-foreground-subtle">
                  {text(`sourceServer.state.${connection?.state ?? "offline"}`)}
                </span>
              </div>
              {profile.sourceServerId ? (
                <p className="break-all text-ui-xs text-foreground-subtle">
                  {profile.sourceServerId}
                </p>
              ) : null}
              <ProfileEditor
                profile={profile}
                pending={busy}
                onSave={(next) => {
                  if (
                    next.configurationMode === "mirror-personal" &&
                    profile.configurationMode !== "mirror-personal"
                  )
                    setConfirmation({ kind: "mirror", profile: next });
                  else void run(() => service.saveProfile(next));
                }}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      service.connectProfile({
                        profileId: profile.profileId,
                        generation: profile.generation,
                      }),
                    )
                  }
                >
                  {text("sourceServer.connect")}
                </Button>
                {profile.sourceServerId ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        service.disconnectSource({ sourceServerId: profile.sourceServerId! }),
                      )
                    }
                  >
                    {text("sourceServer.disconnect")}
                  </Button>
                ) : null}
                {profile.sourceServerId
                  ? (["restart", "stop"] as const).map((action) => (
                      <Button
                        key={action}
                        variant={action === "stop" ? "destructive" : "secondary"}
                        data-testid={"source-server-" + action}
                        disabled={busy || !lifecycleEnabled}
                        onClick={() =>
                          void run(
                            async () =>
                              sourceServerRunningTasksResultSchema.parse(
                                await service.getSourceRunningTasks(profile.sourceServerId!),
                              ),
                            (runningTasks) =>
                              setConfirmation({ kind: action, profile, runningTasks }),
                          )
                        }
                      >
                        {text(
                          action === "stop"
                            ? "settings.source.stopRemoteService"
                            : "settings.source.restartRemoteService",
                        )}
                      </Button>
                    ))
                  : null}
                {connection?.state === "identity-change-pending" &&
                connection.pendingSourceServerId ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      setConfirmation({
                        kind: "identity",
                        profile,
                        expectedSourceServerId: connection.pendingSourceServerId!,
                      })
                    }
                  >
                    {text("sourceServer.confirmIdentity")}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmation({ kind: "remove", profile })}
                >
                  {text("sourceServer.removeProfile")}
                </Button>
              </div>
            </section>
          );
        })
      )}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            {text(
              confirmation?.kind === "stop"
                ? "settings.source.stopRemoteServiceTitle"
                : confirmation?.kind === "restart"
                  ? "settings.source.restartRemoteServiceTitle"
                  : confirmation?.kind === "mirror"
                    ? "sourceServer.mirrorTitle"
                    : confirmation?.kind === "identity"
                      ? "sourceServer.identityTitle"
                      : "sourceServer.removeTitle",
            )}
          </AlertDialogTitle>
          <AlertDialogDescription className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
            {lifecycleDescription ??
              text(
                confirmation?.kind === "mirror"
                  ? "sourceServer.mirrorDescription"
                  : confirmation?.kind === "identity"
                    ? "sourceServer.identityDescription"
                    : "sourceServer.removeDescription",
              )}
          </AlertDialogDescription>
          {confirmation?.kind === "identity" ? (
            <p className="break-all text-ui-sm">
              {confirmation.profile.sourceServerId} / {confirmation.expectedSourceServerId}
            </p>
          ) : null}
          <AlertDialogFooter>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmation(null)}>
              {text("common.cancel")}
            </Button>
            <Button
              disabled={busy}
              data-testid={
                confirmation && "runningTasks" in confirmation
                  ? "source-server-lifecycle-confirm"
                  : undefined
              }
              variant={confirmation?.kind === "stop" ? "destructive" : "default"}
              onClick={() => {
                if (!confirmation) return;
                const pending = confirmation;
                const currentProfile = state.snapshot.directory.profiles.find(
                  (profile) => profile.profileId === pending.profile.profileId,
                );
                // 确认期间线路可能被编辑或删除；旧清单不能授权新线路的停止/重启。
                if (!currentProfile || currentProfile.generation !== pending.profile.generation) {
                  setConfirmation(null);
                  setError(true);
                  return;
                }
                void run(() =>
                  pending.kind === "stop"
                    ? service.stopSource(pending.profile.sourceServerId!)
                    : pending.kind === "restart"
                      ? service.restartSource(pending.profile.sourceServerId!)
                      : pending.kind === "mirror"
                        ? service.saveProfile(pending.profile)
                        : pending.kind === "remove"
                          ? service.removeProfile({
                              profileId: pending.profile.profileId,
                              generation: pending.profile.generation,
                            })
                          : service.confirmIdentityChange({
                              profileId: pending.profile.profileId,
                              generation: pending.profile.generation,
                              expectedSourceServerId: pending.expectedSourceServerId,
                            }),
                );
              }}
            >
              {text("sourceServer.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
