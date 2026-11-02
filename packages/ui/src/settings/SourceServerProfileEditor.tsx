import { useState } from "react";
import type { ConnectionProfile } from "@zcode/shared";
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

export function ProfileEditor({
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
