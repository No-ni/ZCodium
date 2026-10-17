import { expect, it } from "vitest";
import { mapWorkspaceFileEntriesToSearchCandidates } from "@zcode/shared/workspaceFileSearch";
import { searchWorkspaceFileTerms } from "../../services/src/file/workspaceFileTermSearch.js";

it("preserves command center AND matching, file-only results, ordering and limits", async () => {
  const entries = ["SRC/a.TSX", "src/b.tsx", "src/c.ts", "test/a.tsx", "src/d.tsx"].map(
    (relativePath, i) => ({
      relativePath,
      name: relativePath.split("/").at(-1)!,
      path: `C:/synthetic/${relativePath}`,
      type: i === 4 ? ("directory" as const) : ("file" as const),
    }),
  );
  const candidates = mapWorkspaceFileEntriesToSearchCandidates(entries);
  expect(await searchWorkspaceFileTerms(candidates, "SRC tsx", 80)).toEqual(entries.slice(0, 2));
  expect(await searchWorkspaceFileTerms(candidates, "SRC tsx", 1)).toEqual(entries.slice(0, 1));
  expect(await searchWorkspaceFileTerms(candidates, " ", 80)).toEqual([]);
  expect(await searchWorkspaceFileTerms(candidates, "missing", 80)).toEqual([]);
});
