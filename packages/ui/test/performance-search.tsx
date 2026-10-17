import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  useWorkspaceFileSearchIndex,
  useWorkspaceFileSearchResults,
} from "@/workspace-file-tree/useWorkspaceFileSearchIndex.js";

function Fixture() {
  const [query, setQuery] = useState("alpha");
  const [rootPath, setRootPath] = useState("/synthetic/a");
  const index = useWorkspaceFileSearchIndex({
    workspacePath: rootPath,
    enabled: query.trim().length > 0,
  });
  const items = useWorkspaceFileSearchResults({
    packed: index.packed,
    query,
    workspacePath: rootPath,
  });
  return (
    <>
      <input
        aria-label="File query"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <button onClick={() => setRootPath("/synthetic/b")}>Switch root</button>
      <button onClick={index.refresh}>Refresh</button>
      <output id="loading">{String(index.loading)}</output>
      <output id="paths">{items.map((item) => item.path).join("|")}</output>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
