import { createRoot } from "react-dom/client";
import { ServiceProvider } from "../../../packages/ui/src/hooks/useServices.js";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { SourceServerSettingsSection } from "../../../packages/ui/src/settings/SourceServerSettingsSection.js";
import "../../../packages/ui/src/styles.css";

const listeners = new Set<() => void>();
const snapshot = {
  directory: {
    schemaVersion: 1,
    generation: 1,
    profiles: [
      {
        profileId: "fixture-profile",
        generation: 1,
        sourceServerId: "fixture-source",
        displayName: "Fixture device",
        createdAt: 1,
        configurationMode: "target",
        target: { kind: "docker", container: "fixture" },
      },
    ],
    servers: [
      {
        sourceServerId: "fixture-source",
        displayName: "Fixture device",
        version: "3.17.1",
        lastOnlineAt: 1,
      },
    ],
  },
  states: [
    {
      profileId: "fixture-profile",
      generation: 1,
      sourceServerId: "fixture-source",
      state: "online",
      updatedAt: 1,
    },
  ],
};
const calls: string[] = [];
const management = {
  getCapabilities: async () => ({ version: 1 }),
  getSnapshot: async () => structuredClone(snapshot),
  onDidChange(listener: () => void) {
    listeners.add(listener);
    return {
      dispose() {
        listeners.delete(listener);
      },
    };
  },
  async getSourceRunningTasks() {
    calls.push("running-tasks");
    return { available: false };
  },
  async stopSource() {
    calls.push("stop");
    snapshot.states[0].state = "offline";
    listeners.forEach((listener) => listener());
    return structuredClone(snapshot);
  },
  async restartSource() {
    calls.push("restart");
    snapshot.states[0].state = "online";
    listeners.forEach((listener) => listener());
    return structuredClone(snapshot);
  },
};
Object.assign(window, { fixtureCalls: calls });
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={{ sourceServerManagementService: management } as never}>
    <ZCodeIntlProvider initialLocale="en-US">
      <SourceServerSettingsSection />
    </ZCodeIntlProvider>
  </ServiceProvider>,
);
