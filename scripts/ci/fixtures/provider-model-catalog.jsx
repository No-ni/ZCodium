import { useState } from "react";
import { createRoot } from "react-dom/client";
import bundled from "../../../config/provider/zcode-builtin.json";
import { ProviderModelsSection } from "../../../packages/ui/src/settings/model-provider-section/ProviderCardSections.js";
import { ServiceProvider } from "../../../packages/ui/src/hooks/useServices.js";
import { PlatformProvider } from "../../../packages/ui/src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { TooltipProvider } from "../../../packages/ui/src/components/ui/tooltip.js";

const params = new URLSearchParams(location.search);
const defaults = bundled.config.modelConfigRules.modelRules[0].config;
const marker = "SYNTHETIC_CATALOG_PRIVATE_MARKER";
const fixture = { writes: [], fetches: 0, failedB: false };
window.catalogFixture = fixture;
document.documentElement.className = "zai-light";
const services = {
  providerSettingsService: {
    async resolveModelConfig() {
      return { inheritedConfig: defaults, effectiveConfig: defaults, issues: [] };
    },
  },
};
const platform = {
  openExternal() {
    throw new Error("Unexpected external navigation");
  },
};

function CatalogFixture() {
  const [models, setModels] = useState([]);
  return (
    <ProviderModelsSection
      providerId="fixture-provider"
      providerName="Fixture Provider"
      providerAccess={{ type: "api-key" }}
      apiFormat="openai-chat-completions"
      models={models}
      settingsRevision={models.length}
      onModelCommit={() => {
        throw new Error("Unexpected model edit");
      }}
      onDeleteModel={() => {
        throw new Error("Unexpected model deletion");
      }}
      onFetchModels={async () => {
        fixture.fetches++;
        if (params.get("mode") === "fetch-error") throw new Error(marker);
        return {
          success: true,
          source: "primary",
          modelIds: ["catalog-a", "catalog-b", "catalog-c"],
          metadata: { "catalog-a": { contextWindow: 16384, maxOutputTokens: 4096 } },
        };
      }}
      onAddModel={async (model) => {
        fixture.writes.push(structuredClone(model));
        if (model.modelId === "catalog-b" && !fixture.failedB) {
          fixture.failedB = true;
          throw new Error(marker);
        }
        setModels((current) => [...current, { ...model, config: defaults }]);
      }}
    />
  );
}

const root = createRoot(document.getElementById("root"));
fixture.unmount = () => root.unmount();
root.render(
  <ZCodeIntlProvider initialLocale={params.get("locale") || "en-US"}>
    <ServiceProvider services={services}>
      <PlatformProvider platform={platform}>
        <TooltipProvider>
          <main>
            <CatalogFixture />
          </main>
        </TooltipProvider>
      </PlatformProvider>
    </ServiceProvider>
  </ZCodeIntlProvider>,
);
