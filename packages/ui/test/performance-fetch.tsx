import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useWorkspaceFileSearchIndex } from "@/workspace-file-tree/useWorkspaceFileSearchIndex.js";

function Index({
  enabled,
  identity,
  remoteSessionId,
}: {
  enabled: boolean;
  identity?: string;
  remoteSessionId?: string;
}) {
  const index = useWorkspaceFileSearchIndex({
    workspacePath: "/synthetic/same",
    workspaceIdentity: identity,
    workspaceRemoteSessionId: remoteSessionId,
    enabled,
  });
  return (
    <>
      <output id="loading">{String(index.loading)}</output>
      <output id="packed">{index.packed}</output>
      <output id="error">{index.error?.message ?? ""}</output>
      <button onClick={index.refresh}>Refresh</button>
    </>
  );
}
function Fixture() {
  const [enabled, setEnabled] = useState(true);
  const [identity, setIdentity] = useState<string>();
  const [remoteSessionId, setRemoteSessionId] = useState<string>();
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <button onClick={() => setEnabled(false)}>Close search</button>
      <button onClick={() => setEnabled(true)}>Open search</button>
      <button onClick={() => setIdentity("remote-next")}>Switch identity</button>
      <button onClick={() => setRemoteSessionId("session-next")}>Switch remote session</button>
      <button onClick={() => setMounted(false)}>Unmount</button>
      {mounted ? (
        <Index enabled={enabled} identity={identity} remoteSessionId={remoteSessionId} />
      ) : null}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
