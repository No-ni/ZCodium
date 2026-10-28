import { useState } from "react";
import type { ConnectionProfile } from "@zcode/shared";
import { useSourceServerManagement } from "@/hooks/useSourceServerManagement.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
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
  | { kind: "remove"; profile: ConnectionProfile };

function ProfileEditor({
  profile,
  pending,
  onSave,
}: {
  profile: ConnectionProfile;
  pending: boolean;
  onSave: (profile: ConnectionProfile) => void;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState(profile);
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
      <Input
        aria-label={intl.formatMessage({ id: "sourceServer.profileName" })}
        value={draft.displayName}
        onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
        disabled={pending}
      />
      {draft.target.kind === "ssh" ? (
        <>
          <Input
            aria-label={intl.formatMessage({ id: "sourceServer.host" })}
            value={draft.target.host}
            onChange={(event) => {
              if (draft.target.kind === "ssh")
                setDraft({ ...draft, target: { ...draft.target, host: event.target.value } });
            }}
            disabled={pending}
          />
          <Input
            aria-label={intl.formatMessage({ id: "sourceServer.username" })}
            value={draft.target.username}
            onChange={(event) => {
              if (draft.target.kind === "ssh")
                setDraft({ ...draft, target: { ...draft.target, username: event.target.value } });
            }}
            disabled={pending}
          />
          <Input
            aria-label={intl.formatMessage({ id: "sourceServer.port" })}
            type="number"
            min={1}
            max={65535}
            value={draft.target.port ?? 22}
            onChange={(event) => {
              if (draft.target.kind === "ssh")
                setDraft({
                  ...draft,
                  target: { ...draft.target, port: Number(event.target.value) },
                });
            }}
            disabled={pending}
          />
        </>
      ) : draft.target.kind === "wsl" ? (
        <Input
          aria-label={intl.formatMessage({ id: "sourceServer.distro" })}
          value={draft.target.distro ?? ""}
          onChange={(event) => {
            if (draft.target.kind === "wsl")
              setDraft({
                ...draft,
                target: { ...draft.target, distro: event.target.value || undefined },
              });
          }}
          disabled={pending}
        />
      ) : (
        <Input
          aria-label={intl.formatMessage({ id: "sourceServer.container" })}
          value={draft.target.container}
          onChange={(event) => {
            if (draft.target.kind === "docker")
              setDraft({ ...draft, target: { ...draft.target, container: event.target.value } });
          }}
          disabled={pending}
        />
      )}
      <Select
        value={draft.configurationMode}
        onValueChange={(value) =>
          setDraft({ ...draft, configurationMode: value === "mirror-personal" ? value : "target" })
        }
        disabled={pending}
      >
        <SelectTrigger
          aria-label={intl.formatMessage({ id: "sourceServer.configurationMode" })}
          className="w-full min-w-0"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="target">
            {intl.formatMessage({ id: "sourceServer.configuration.target" })}
          </SelectItem>
          <SelectItem value="mirror-personal">
            {intl.formatMessage({ id: "sourceServer.configuration.mirror" })}
          </SelectItem>
        </SelectContent>
      </Select>
      <Button
        variant="secondary"
        disabled={pending || !draft.displayName.trim()}
        onClick={() => onSave(draft)}
      >
        {intl.formatMessage({ id: "common.save" })}
      </Button>
    </div>
  );
}

export function SourceServerSettingsSection() {
  const { intl } = useZCodeIntl();
  const { service, state, refresh } = useSourceServerManagement();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy || !service) return;
    setBusy(true);
    setError(false);
    try {
      await operation();
      await refresh();
      setConfirmation(null);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const text = (id: string) => intl.formatMessage({ id });
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
              confirmation?.kind === "mirror"
                ? "sourceServer.mirrorTitle"
                : confirmation?.kind === "identity"
                  ? "sourceServer.identityTitle"
                  : "sourceServer.removeTitle",
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {text(
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
              onClick={() => {
                if (!confirmation) return;
                const pending = confirmation;
                void run(() =>
                  pending.kind === "mirror"
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
