import type {
  ConnectionProfile,
  SourceServerDirectorySnapshot,
  SourceServerConnectionStateSnapshot,
} from "@zcode/shared";
import type { Emitter } from "@zcode/rpc";
import type { SourceServerOperationFlights } from "./sourceServerOperationFlights.js";
import type { Flight, OnlineSource } from "./sourceServerConnectionTypes.js";
import { releaseManagedSource } from "./sourceServerConnectionFlights.js";

interface ProfileRetirementContext {
  operations: SourceServerOperationFlights;
  activeFlights: Set<Flight>;
  online: Map<string, OnlineSource>;
  states: Map<string, SourceServerConnectionStateSnapshot>;
  activeDisposals: Set<Promise<void>>;
  changes: Emitter<void>;
  setState(profile: ConnectionProfile, state: SourceServerConnectionStateSnapshot["state"]): void;
}

// 只消费 Manager 已验收的目录快照，所有集合与释放链仍归原 Manager。
export function retireSourceProfiles(
  snapshot: SourceServerDirectorySnapshot,
  {
    operations,
    activeFlights,
    online,
    states,
    activeDisposals,
    changes,
    setState,
  }: ProfileRetirementContext,
): void {
  operations.retireProfiles(snapshot.profiles);
  for (const flight of activeFlights) {
    const current = snapshot.profiles.find(
      (profile) => profile.profileId === flight.profile.profileId,
    );
    const acceptedConfirmation = Boolean(
      flight.expectedSourceServerId &&
      current?.sourceServerId === flight.expectedSourceServerId &&
      current.generation === flight.profile.generation + 1,
    );
    if (acceptedConfirmation) flight.profile = current!;
    else if (!current || current.generation !== flight.profile.generation)
      flight.controller.abort();
  }
  for (const [id, source] of online) {
    if (
      snapshot.profiles.some(
        (profile) =>
          profile.profileId === source.profile.profileId &&
          profile.generation === source.profile.generation,
      )
    )
      continue;
    if (online.get(id) !== source) continue;
    online.delete(id);
    for (const state of states.values()) {
      if (state.sourceServerId !== id || state.state !== "online") continue;
      const current = snapshot.profiles.find(
        (profile) =>
          profile.profileId === state.profileId && profile.generation === state.generation,
      );
      if (current) setState(current, "offline");
    }
    void releaseManagedSource(source, activeDisposals).catch(() => undefined);
  }
  for (const [id, state] of states) {
    if (
      !snapshot.profiles.some(
        (profile) => profile.profileId === id && profile.generation === state.generation,
      )
    )
      states.delete(id);
  }
  changes.fire();
}
