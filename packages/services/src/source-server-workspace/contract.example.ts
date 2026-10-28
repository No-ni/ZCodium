import type {
  WorkspaceAliasScope,
  WorkspaceAliasConfirmation,
  WorkspaceCommittedSnapshotPort,
} from "./contract.js";
import type { ISourceWorkspaceInspectionService } from "./inspection-contract.js";
export const exampleScope: WorkspaceAliasScope = {
  sourceServerId: "fixture_source",
  workspacePath: "/fixture/project",
};
export function explicitConfirmation(plan: {
  sourceGeneration: number;
  candidateVersion: string;
  planHash: string;
  confirmationToken: string;
  canonicalKey: string;
}): WorkspaceAliasConfirmation {
  return { ...exampleScope, ...plan, acknowledgeMerge: true, choices: [] };
}

export async function inspectWorkspaceAdmission(service: ISourceWorkspaceInspectionService) {
  const result = await service.inspect(exampleScope);
  return result.state === "clear";
}

export function readCommittedSnapshot<T>(
  port: WorkspaceCommittedSnapshotPort,
  dataRoot: string,
  databasePath: string,
  readIsolated: (path: string) => Promise<T>,
): Promise<T> {
  return port.withSnapshot({ dataRoot, databasePath }, ({ databasePath: isolated }) =>
    readIsolated(isolated),
  );
}
