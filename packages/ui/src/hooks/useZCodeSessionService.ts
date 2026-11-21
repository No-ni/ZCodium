import type { IZCodeSessionService } from "@zcode/services";
import { useContextOrWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  const services = useContextOrWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  return services.zcodeSessionService;
}
