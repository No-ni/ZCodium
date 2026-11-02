import type {
  SourceServerIdentityConfirmation,
  SourceServerManagementSnapshot,
  RemoteTarget,
} from "@zcode/shared";
import { profileMatchesRemoteTarget } from "@/lib/remoteConnectionWizard.js";

/** 确认绑定线路代际及待确认身份，不能把旧失败页的授权用到后来编辑的线路。 */
export function getRemoteIdentityConfirmation(
  snapshot: SourceServerManagementSnapshot | null,
  target: RemoteTarget | null,
  preferredProfileId?: string,
): SourceServerIdentityConfirmation | null {
  if (!snapshot || !target || target.kind === "server") return null;
  const profile = snapshot.directory.profiles.find(
    (candidate) =>
      (!preferredProfileId || candidate.profileId === preferredProfileId) &&
      profileMatchesRemoteTarget(candidate, target),
  );
  if (!profile) return null;
  const state = snapshot.states.find(
    (candidate) =>
      candidate.profileId === profile.profileId &&
      candidate.generation === profile.generation &&
      candidate.state === "identity-change-pending" &&
      candidate.pendingSourceServerId,
  );
  if (!state?.pendingSourceServerId) return null;
  return {
    profileId: profile.profileId,
    generation: profile.generation,
    expectedSourceServerId: state.pendingSourceServerId,
  };
}
