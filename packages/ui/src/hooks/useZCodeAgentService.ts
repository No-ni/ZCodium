import type { IZCodeAgentService } from "@zcode/services";
import { useContextOrWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  const services = useContextOrWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  return services.zcodeAgentService;
}
