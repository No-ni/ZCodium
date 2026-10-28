import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import {
  connectionProfileSchema,
  sourceServerDirectorySchema,
  stripRemoteTargetSecrets,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerDirectorySnapshot,
  type SourceServerRecord,
} from "@zcode/shared";
import type { ICredentialService, ISettingService } from "@zcode/services";

export class SourceServerDirectoryError extends Error {
  constructor(
    readonly code: "source-server-profile-stale" | "source-server-identity-change-pending",
    readonly pendingSourceServerId?: string,
  ) {
    super(
      code === "source-server-profile-stale"
        ? "Source profile is stale"
        : "Source identity changed and requires confirmation",
    );
  }
}

interface CredentialTransaction {
  put(key: string, value: string | null): Promise<void>;
}

export class SourceServerDirectory {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly changes = new Emitter<SourceServerDirectorySnapshot>();
  private closed = false;
  readonly onDidChange = this.changes.event;

  constructor(
    private readonly options: {
      settingService: Pick<ISettingService, "get" | "update">;
      credentialService: ICredentialService;
      createId?: () => string;
      now?: () => number;
    },
  ) {}

  private assertOpen(): void {
    if (this.closed) throw new Error("Source Directory is closed");
  }

  async snapshot(): Promise<SourceServerDirectorySnapshot> {
    this.assertOpen();
    const settings = await this.options.settingService.get();
    this.assertOpen();
    return sourceServerDirectorySchema.parse(
      settings.sourceServerDirectory ?? {
        schemaVersion: 1,
        generation: 0,
        profiles: [],
        servers: [],
      },
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(() => {
      this.assertOpen();
      return operation();
    });
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async persist(snapshot: SourceServerDirectorySnapshot): Promise<void> {
    this.assertOpen();
    const parsed = sourceServerDirectorySchema.parse(snapshot);
    await this.options.settingService.update({ sourceServerDirectory: parsed });
    if (!this.closed) this.changes.fire(parsed);
  }

  private current(
    snapshot: SourceServerDirectorySnapshot,
    expected: Pick<ConnectionProfile, "profileId" | "generation">,
  ): ConnectionProfile {
    const current = snapshot.profiles.find((profile) => profile.profileId === expected.profileId);
    if (!current || current.generation !== expected.generation)
      throw new SourceServerDirectoryError("source-server-profile-stale");
    return current;
  }

  private async withCredentials<T>(
    operation: (transaction: CredentialTransaction) => Promise<T>,
  ): Promise<T> {
    const previous = new Map<string, string | null>();
    const put = async (key: string, value: string | null) => {
      if (!previous.has(key)) previous.set(key, await this.options.credentialService.load(key));
      if (value === null) await this.options.credentialService.delete(key);
      else await this.options.credentialService.save(key, value);
    };
    try {
      return await operation({ put });
    } catch (error) {
      // 凭据没有 settings 事务；目录提交失败必须还原，不能遗留未提交线路的密码或删除。
      const failures: unknown[] = [];
      for (const [key, value] of previous) {
        try {
          if (value === null) await this.options.credentialService.delete(key);
          else await this.options.credentialService.save(key, value);
        } catch (failure) {
          failures.push(failure);
        }
      }
      if (failures.length)
        throw new AggregateError([error, ...failures], "Source credential rollback failed");
      throw error;
    }
  }

  async ensureProfile(target: RemoteTarget): Promise<ConnectionProfile> {
    return this.enqueue(async () => {
      const snapshot = await this.snapshot();
      const sanitized = stripRemoteTargetSecrets(target);
      const existing = snapshot.profiles.find(
        (profile) => targetKey(profile.target) === targetKey(sanitized),
      );
      if (existing) return existing;
      const profileTarget =
        sanitized.kind === "ssh"
          ? {
              kind: sanitized.kind,
              host: sanitized.host,
              port: sanitized.port,
              username: sanitized.username,
              sshConfigAlias: sanitized.sshConfigAlias,
              privateKeyPath: sanitized.privateKeyPath,
            }
          : sanitized;
      const profile = connectionProfileSchema.parse({
        profileId: this.options.createId?.() ?? randomUUID(),
        generation: 1,
        displayName:
          sanitized.kind === "ssh"
            ? (sanitized.sshConfigAlias ?? sanitized.host)
            : sanitized.kind === "wsl"
              ? (sanitized.distro ?? "WSL")
              : sanitized.container,
        target: profileTarget,
        configurationMode: "target",
        createdAt: this.options.now?.() ?? Date.now(),
      });
      await this.persist({
        ...snapshot,
        generation: snapshot.generation + 1,
        profiles: [...snapshot.profiles, profile],
      });
      return profile;
    });
  }

  async assertCurrent(
    expected: Pick<ConnectionProfile, "profileId" | "generation">,
  ): Promise<ConnectionProfile> {
    return this.current(await this.snapshot(), expected);
  }

  async recordHandshake(
    expected: ConnectionProfile,
    info: { serverId: string; version: string },
    options: {
      expectedSourceServerId?: string;
      authenticatedTarget?: RemoteTarget;
    } = {},
  ): Promise<ConnectionProfile> {
    return this.enqueue(async () => {
      const snapshot = await this.snapshot();
      const current = this.current(snapshot, expected);
      if (options.expectedSourceServerId && options.expectedSourceServerId !== info.serverId)
        throw new SourceServerDirectoryError(
          "source-server-identity-change-pending",
          info.serverId,
        );
      const identityChanged = Boolean(
        current.sourceServerId && current.sourceServerId !== info.serverId,
      );
      if (identityChanged && !options.expectedSourceServerId)
        throw new SourceServerDirectoryError(
          "source-server-identity-change-pending",
          info.serverId,
        );
      return this.withCredentials(async ({ put }) => {
        let target = current.target;
        const authenticated = options.authenticatedTarget;
        if (authenticated && targetKey(target) !== targetKey(authenticated))
          throw new SourceServerDirectoryError("source-server-profile-stale");
        if (target.kind === "ssh" && authenticated?.kind === "ssh") {
          const save = async (suffix: string, value: string | undefined) => {
            if (!value) return undefined;
            const key = `connection-profile:${current.profileId}:${suffix}`;
            await put(key, value);
            return key;
          };
          const passwordKey = await save("password", authenticated.password);
          const passphraseKey = await save(
            "private-key-passphrase",
            authenticated.privateKeyPassphrase,
          );
          target = {
            ...target,
            ...(passwordKey ? { passwordCredentialKey: passwordKey } : {}),
            ...(passphraseKey ? { privateKeyPassphraseCredentialKey: passphraseKey } : {}),
          };
        }
        const now = this.options.now?.() ?? Date.now();
        const next = {
          ...current,
          target,
          sourceServerId: info.serverId,
          generation: current.generation + Number(identityChanged),
          lastConnectedAt: now,
        };
        const server = snapshot.servers.find((entry) => entry.sourceServerId === info.serverId);
        const retained = snapshot.servers
          .filter((entry) => entry.sourceServerId !== info.serverId)
          .map((entry) =>
            identityChanged ? withoutPreferredProfile(entry, current.profileId) : entry,
          );
        await this.persist({
          ...snapshot,
          generation: snapshot.generation + 1,
          profiles: snapshot.profiles.map((profile) =>
            profile.profileId === current.profileId ? next : profile,
          ),
          servers: [
            ...retained,
            {
              sourceServerId: info.serverId,
              displayName: server?.displayName ?? current.displayName,
              version: info.version,
              preferredProfileId: server?.preferredProfileId ?? current.profileId,
              lastOnlineAt: now,
            },
          ],
        });
        return next;
      });
    });
  }

  async saveProfile(input: ConnectionProfile): Promise<ConnectionProfile> {
    const parsed = connectionProfileSchema.parse(input);
    return this.enqueue(async () => {
      const snapshot = await this.snapshot();
      const current = this.current(snapshot, parsed);
      if (parsed.target.kind === "ssh") {
        for (const field of [
          "passwordCredentialKey",
          "privateKeyPassphraseCredentialKey",
        ] as const) {
          if (
            parsed.target[field] !== undefined &&
            (current.target.kind !== "ssh" || parsed.target[field] !== current.target[field])
          )
            throw new Error("Source credential reference is not owned by this Profile");
        }
      }
      const changedRoute = targetKey(parsed.target) !== targetKey(current.target);
      const target =
        parsed.target.kind === "ssh"
          ? {
              ...parsed.target,
              passwordCredentialKey:
                !changedRoute && current.target.kind === "ssh"
                  ? current.target.passwordCredentialKey
                  : undefined,
              privateKeyPassphraseCredentialKey:
                !changedRoute && current.target.kind === "ssh"
                  ? current.target.privateKeyPassphraseCredentialKey
                  : undefined,
            }
          : parsed.target;
      const next = connectionProfileSchema.parse({
        ...current,
        displayName: parsed.displayName,
        target,
        configurationMode: parsed.configurationMode,
        generation: current.generation + 1,
      });
      return this.withCredentials(async ({ put }) => {
        // 密码只属于认证过的旧线路；编辑目标不能把它转发到新的 SSH 地址。
        if (changedRoute) for (const key of ownedCredentialKeys(current)) await put(key, null);
        await this.persist({
          ...snapshot,
          generation: snapshot.generation + 1,
          profiles: snapshot.profiles.map((profile) =>
            profile.profileId === current.profileId ? next : profile,
          ),
        });
        return next;
      });
    });
  }

  async removeProfile(profileId: string, expectedGeneration: number): Promise<void> {
    await this.enqueue(async () => {
      const snapshot = await this.snapshot();
      const current = this.current(snapshot, { profileId, generation: expectedGeneration });
      await this.withCredentials(async ({ put }) => {
        for (const key of ownedCredentialKeys(current)) await put(key, null);
        // 删除线路不删除 Source 或远端数据，也不自动为它选择另一条线路。
        await this.persist({
          ...snapshot,
          generation: snapshot.generation + 1,
          profiles: snapshot.profiles.filter((profile) => profile.profileId !== profileId),
          servers: snapshot.servers.map((server) => withoutPreferredProfile(server, profileId)),
        });
      });
    });
  }

  async resolveTarget(profile: ConnectionProfile): Promise<RemoteTarget> {
    const current = await this.assertCurrent(profile);
    const target = current.target;
    if (target.kind !== "ssh") return target;
    const { passwordCredentialKey, privateKeyPassphraseCredentialKey, ...publicTarget } = target;
    const [password, privateKeyPassphrase] = await Promise.all([
      passwordCredentialKey ? this.options.credentialService.load(passwordCredentialKey) : null,
      privateKeyPassphraseCredentialKey
        ? this.options.credentialService.load(privateKeyPassphraseCredentialKey)
        : null,
    ]);
    await this.assertCurrent(current);
    return {
      ...publicTarget,
      ...(password ? { password } : {}),
      ...(privateKeyPassphrase ? { privateKeyPassphrase } : {}),
    };
  }

  dispose(): void {
    this.closed = true;
    this.changes.dispose();
  }
}

function withoutPreferredProfile(
  server: SourceServerRecord,
  profileId: string,
): SourceServerRecord {
  if (server.preferredProfileId !== profileId) return server;
  const { preferredProfileId: _preferred, ...rest } = server;
  return rest;
}

function ownedCredentialKeys(profile: ConnectionProfile): string[] {
  if (profile.target.kind !== "ssh") return [];
  const keys = [
    profile.target.passwordCredentialKey,
    profile.target.privateKeyPassphraseCredentialKey,
  ];
  return keys.filter((key): key is string =>
    Boolean(key?.startsWith(`connection-profile:${profile.profileId}:`)),
  );
}

function targetKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return JSON.stringify([
        "ssh",
        target.host.trim().toLowerCase(),
        target.port ?? 22,
        target.username.trim(),
        target.sshConfigAlias ?? "",
        target.privateKeyPath ?? "",
      ]);
    case "wsl":
      return JSON.stringify(["wsl", target.distro ?? "", target.user ?? ""]);
    case "docker":
      return JSON.stringify(["docker", target.container]);
  }
}
