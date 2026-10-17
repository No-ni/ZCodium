import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeSessionSubagentsResult } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useSessionSubagents } from "@/hooks/useSessionSubagents.js";

const TOTAL = 500;

type PageRequest = {
  endedCursor?: string;
  endedLimit?: number;
};

type PendingRequest = {
  params: PageRequest;
  resolve: (value: ZCodeSessionSubagentsResult) => void;
};

type FixtureApi = {
  calls: () => PageRequest[];
  defer: (selector: string) => void;
  pendingCount: () => number;
  resolveNext: () => void;
};

declare global {
  interface Window {
    performanceRound12Subagents: FixtureApi;
  }
}

const calls: PageRequest[] = [];
const pending: PendingRequest[] = [];
let deferredSelector: string | null = null;

function createPage(params: PageRequest): ZCodeSessionSubagentsResult {
  const start = Number(params.endedCursor ?? 0);
  const end = Math.min(start + (params.endedLimit ?? 20), TOTAL);
  return {
    revision: 7,
    childSessionIds: [],
    running: [],
    ended: {
      total: TOTAL,
      items: Array.from({ length: end - start }, (_, index) => ({
        childSessionId: `child-${start + index}`,
      })),
      ...(end < TOTAL ? { nextCursor: String(end) } : {}),
    },
  } as ZCodeSessionSubagentsResult;
}

function listSessionSubagents(params: PageRequest): Promise<ZCodeSessionSubagentsResult> {
  const request = {
    endedLimit: params.endedLimit,
    ...(params.endedCursor === undefined ? {} : { endedCursor: params.endedCursor }),
  };
  calls.push(request);
  const selector = request.endedCursor ?? "first";
  if (selector === deferredSelector) {
    deferredSelector = null;
    return new Promise((resolve) => pending.push({ params: request, resolve }));
  }
  return Promise.resolve(createPage(request));
}

const services = {
  zcodeAgentService: { listSessionSubagents },
} as unknown as IServiceAccessor;

window.performanceRound12Subagents = {
  calls: () => calls.map((request) => ({ ...request })),
  defer: (selector) => {
    deferredSelector = selector;
  },
  pendingCount: () => pending.length,
  resolveNext: () => {
    const request = pending.shift();
    if (request) request.resolve(createPage(request.params));
  },
};

function DirectoryHarness() {
  const directory = useSessionSubagents({
    enabled: true,
    sessionId: "synthetic-session",
    workspacePath: "C:/synthetic/workspace",
  });
  const [refreshCount, setRefreshCount] = useState(0);
  const ids = directory.ended.items.map((item) => item.childSessionId).join(",");

  return (
    <section>
      <button onClick={() => void directory.loadMore()}>Load 20</button>
      <button
        onClick={async () => {
          await directory.refresh();
          setRefreshCount((count) => count + 1);
        }}
      >
        Refresh
      </button>
      <output
        id="directory"
        data-count={directory.ended.items.length}
        data-next-cursor={directory.ended.nextCursor ?? ""}
        data-ids={ids}
      />
      <output id="refresh-complete">{refreshCount}</output>
    </section>
  );
}

function App() {
  const [open, setOpen] = useState(true);
  return (
    <ServiceProvider services={services}>
      <button onClick={() => setOpen(false)}>Close directory</button>
      <button onClick={() => setOpen(true)}>Open directory</button>
      {open ? <DirectoryHarness /> : null}
    </ServiceProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
