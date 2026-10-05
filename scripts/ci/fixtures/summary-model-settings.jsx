import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemorySettingsSection } from "../../../packages/ui/src/settings/MemorySettingsSection.js";
import { ServiceProvider } from "../../../packages/ui/src/hooks/useServices.js";
import { PlatformProvider } from "../../../packages/ui/src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { TooltipProvider } from "../../../packages/ui/src/components/ui/tooltip.js";
import { modelConfig } from "./local-model-config.mjs";

const params = new URLSearchParams(location.search);
document.documentElement.className = params.get("theme") === "dark" ? "dark zai-dark" : "zai-light";
window.summaryFixture = { saves: [], failSave: false, holdSave: false, errors: [] };
window.addEventListener("unhandledrejection", (event) =>
  window.summaryFixture.errors.push(String(event.reason)),
);
const services = {
  modelSelectionService: {
    onDidChange: () => ({ dispose() {} }),
    getView: async () => ({
      revision: 1,
      providers: [
        {
          providerId: "fixture",
          providerName: "Fixture Provider",
          config: { api: { type: "openai-chat-completions" }, access: { type: "api-key" } },
          models: [{ modelId: "fixture-model", config: modelConfig }],
        },
      ],
    }),
  },
};

function Fixture() {
  const [selection, setSelection] = useState(
    params.get("mode") === "deleted" ? { providerId: "removed", modelId: "removed-model" } : null,
  );
  return (
    <MemorySettingsSection
      memoryEnabled={false}
      memoryService={{ listProjectMemories: async () => ({ workspaces: [] }) }}
      onMemoryEnabledChange={async () => {}}
      projectMemoryViewerAvailable={false}
      summaryModelSelection={selection}
      onSummaryModelChange={async (next) => {
        const fixture = window.summaryFixture;
        fixture.saves.push(next);
        if (fixture.holdSave)
          await new Promise((resolve) => {
            fixture.releaseSave = resolve;
          });
        if (fixture.failSave) {
          fixture.failSave = false;
          throw new Error("Fixture save failed");
        }
        setSelection(next);
      }}
    />
  );
}

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") || "zh-CN"}>
    <ServiceProvider services={services}>
      <PlatformProvider platform={{}}>
        <TooltipProvider>
          <main className="min-h-screen bg-background text-foreground p-3">
            <Fixture />
          </main>
        </TooltipProvider>
      </PlatformProvider>
    </ServiceProvider>
  </ZCodeIntlProvider>,
);
