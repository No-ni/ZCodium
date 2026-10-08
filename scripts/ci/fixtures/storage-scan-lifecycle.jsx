import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useStorageUsage } from "../../../packages/ui/src/resource-manager/storage/useStorageUsage.ts";

const starts = [];
const cancellations = [];
const listeners = new Set();
const cleans = [];
const bridge = {
  startScan: () => new Promise((resolve, reject) => starts.push({ resolve, reject })),
  cancelScan: async (jobId) => {
    cancellations.push(jobId);
  },
  getSnapshot: async () => null,
  subscribeScanProgress: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  clean: () => new Promise((resolve) => cleans.push(resolve)),
};

function Usage({ active }) {
  const { scanning, snapshot, rescan, clean } = useStorageUsage({ bridge, enabled: active });
  return (
    <>
      <output data-testid="scanning">{String(scanning)}</output>
      <output data-testid="snapshot">{snapshot?.jobId ?? "none"}</output>
      <button onClick={() => void rescan()}>Rescan</button>
      <button onClick={() => void clean({ rootId: "home", categoryId: "logs" })}>Clean</button>
    </>
  );
}

function App() {
  const [active, setActive] = useState(false);
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <button onClick={() => setActive(true)}>Storage</button>
      <button onClick={() => setActive(false)}>Other tab</button>
      <button onClick={() => setMounted(false)}>Unmount</button>
      {mounted && <Usage active={active} />}
    </>
  );
}

window.storageScanFixture = {
  starts,
  cancellations,
  cleans,
  resolve: (index) => starts[index].resolve({ jobId: `scan-${index}` }),
  reject: (index) => starts[index].reject(new Error("Synthetic start failure")),
  finishClean: () =>
    cleans.shift()({ deletedCount: 0, freedBytes: 0, failures: [], skippedCount: 0 }),
  publish: (index, status = "complete") => {
    for (const listener of listeners)
      listener({
        jobId: `scan-${index}`,
        status,
        roots: [],
        errors: [],
        startedAt: 0,
        finishedAt: 1,
      });
  },
};
createRoot(document.getElementById("root")).render(<App />);
