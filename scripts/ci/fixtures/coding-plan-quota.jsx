import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CodingPlanQuotaPanel } from "../../../packages/ui/src/settings/usage-stats/CodingPlanQuotaPanel.js";
import { ServiceProvider } from "../../../packages/ui/src/hooks/useServices.js";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { Button } from "../../../packages/ui/src/components/ui/button.js";

const params = new URLSearchParams(location.search);
document.documentElement.className = params.get("theme") === "dark" ? "dark zai-dark" : "zai-light";
const fixture = (window.codingPlanQuotaFixture = {
  requests: [],
  contextReads: 0,
  snapshots: 0,
  settled: 0,
  subscriptions: 0,
  mounted: true,
  holdNext: params.has("loading"),
  failNext: params.has("error"),
  mode: params.has("zero") ? "zero" : params.has("empty") ? "empty" : "data",
  pending: [],
  events: [],
  external: [],
});
function host(name) {
  let generation = 1;
  const listeners = new Set();
  let context = {
    status: "available",
    contextId: `${name}-opaque-${generation}`,
    providerId: name,
    providerName: name,
    family: "bigmodel",
  };
  return {
    name,
    setContext(reason) {
      context = reason
        ? { status: "unavailable", reason }
        : {
            status: "available",
            contextId: `${name}-opaque-${++generation}`,
            providerId: name,
            providerName: name,
            family: generation % 2 ? "bigmodel" : "zai",
          };
      fixture.events.push(context);
      for (const listener of listeners) listener(context);
    },
    onDidChangeCodingPlanQuotaContext(listener) {
      if (!listeners.has(listener)) fixture.subscriptions++;
      listeners.add(listener);
      return {
        dispose() {
          if (listeners.delete(listener)) fixture.subscriptions--;
        },
      };
    },
    async getCodingPlanQuotaContext() {
      fixture.contextReads++;
      return context;
    },
    async getCodingPlanQuota(request) {
      fixture.requests.push({ host: name, ...request });
      const mode = fixture.mode;
      const failed = fixture.failNext;
      fixture.failNext = false;
      if (fixture.holdNext) {
        fixture.holdNext = false;
        await new Promise((resolve) => fixture.pending.push({ name, resolve }));
      }
      fixture.settled++;
      if (failed) throw new Error("quota-request-failed");
      fixture.snapshots++;
      const remaining = mode === "zero" ? 0 : name === "Host A" ? 30 : 60;
      const limits =
        mode === "empty"
          ? []
          : [
              {
                type: "TIME_LIMIT",
                remaining,
                number: 100,
                percentage: 1 - remaining / 100,
                nextResetTime: 1792832400000,
                usageDetails: [],
              },
            ];
      return {
        fetchedAt: Date.now(),
        family: "bigmodel",
        level: "pro",
        limits,
        remaining: limits[0] ?? null,
      };
    },
  };
}
const hosts = [host("Host A"), host("Host B")];
if (params.has("missing")) hosts[0].setContext("missing-api-key");
if (params.has("unsupported")) hosts[0].setContext("unsupported-provider");
if (params.has("none")) hosts[0].setContext("no-provider");
function App() {
  const [active, setActive] = useState(0);
  const [mounted, setMounted] = useState(true);
  const service = hosts[active];
  const controls = [
    [
      "Next refresh fails",
      () => {
        fixture.failNext = true;
      },
    ],
    [
      "Hold next request",
      () => {
        fixture.holdNext = true;
      },
    ],
    [
      "Release old requests",
      () => {
        for (const item of fixture.pending.splice(0)) item.resolve();
      },
    ],
    ["Change key/provider", () => service.setContext()],
    ["Switch Host", () => setActive(1 - active)],
    ["Remove connection", () => service.setContext("no-provider")],
    ["Missing key", () => service.setContext("missing-api-key")],
    ["Restore connection", () => service.setContext()],
    [
      "Zero on next request",
      () => {
        fixture.mode = "zero";
      },
    ],
    [
      "Empty on next request",
      () => {
        fixture.mode = "empty";
      },
    ],
    [
      "Data on next request",
      () => {
        fixture.mode = "data";
      },
    ],
    [
      mounted ? "Leave usage page" : "Open usage page",
      () => {
        fixture.mounted = !mounted;
        setMounted(!mounted);
      },
    ],
  ];
  return (
    <main className="min-h-screen bg-background text-foreground p-4">
      <aside className="mb-5 space-y-3 border-b border-border pb-4">
        <h2 className="text-ui-base font-medium">
          Coding Plan quota acceptance fixture — {service.name}
        </h2>
        <div className="flex flex-wrap gap-2">
          {controls.map(([label, action]) => (
            <Button key={label} variant="outline" size="sm" onClick={action}>
              {label}
            </Button>
          ))}
        </div>
      </aside>
      <ServiceProvider services={{ usageStatsService: service }}>
        {mounted ? <CodingPlanQuotaPanel /> : <p className="text-ui-base">Usage page closed</p>}
      </ServiceProvider>
    </main>
  );
}
createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") || "en-US"}>
    <App />
  </ZCodeIntlProvider>,
);
