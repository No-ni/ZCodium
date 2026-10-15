import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PluginStorePage } from "../../../packages/ui/src/settings/PluginStorePage.js";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { ServiceProvider } from "../../../packages/ui/src/hooks/useServices.js";
import { PlatformProvider } from "../../../packages/ui/src/hooks/usePlatform.js";
import { TabStoreProvider } from "../../../packages/ui/src/store/TabStoreProvider.js";
import { TooltipProvider } from "../../../packages/ui/src/components/ui/tooltip.js";

const query = new URLSearchParams(location.search);
const locale = query.get("locale") || "en-US";
const official = "zcode-plugins-official";
const state = (window.marketplaceFixture = { reads: 0, updates: [], descriptions: [], open: true });
// superpowers 是官方市场里没有随包图标的条目：目录仍带远端 icon，
// 用来验证「无内置图标的官方插件走中性兜底且不请求远端」。
const availablePlugins = ["browser-use", "documents", "superpowers"].map((name) => ({
  id: `${name}@${official}`,
  name,
  marketplace: official,
  version: "1.0.0",
  installed: false,
  componentTypes: ["skills"],
  description: "Bundled fixture plugin",
  listing: {
    displayName: name,
    category: "productivity",
    icon: `https://cdn-zcode.z.ai/zcode/official-plugin/assets/${name}/icon.png`,
  },
}));
const marketplaces = [
  {
    id: official,
    name: "ZCodium",
    source: { source: "bundled" },
    isOfficial: true,
    pluginCount: 3,
  },
  {
    id: "personal-fixture",
    name: "Personal fixture",
    source: { source: "url", url: "https://self-managed.invalid/catalog.json" },
    isOfficial: false,
    pluginCount: 0,
  },
];
const services = {
  clientConfigService: {
    async getSnapshot() {
      return { pluginStoreOrder: null };
    },
  },
  zcodeSessionService: {},
  skillsService: {},
  pluginManagementService: {
    async listPlugins() {
      return { plugins: [], diagnostics: [] };
    },
    async getPluginsOverview() {
      state.reads++;
      return {
        marketplaces,
        availablePlugins,
        installedPlugins: [],
        restorableBuiltins: [],
        diagnostics: [],
      };
    },
    async updatePluginMarketplace(params) {
      state.updates.push(params.marketplace ?? "all");
      return { diagnostics: [] };
    },
    async describePlugin(params) {
      state.descriptions.push(params);
      return { components: [], diagnostics: [], metadata: { version: "1.0.0" } };
    },
  },
};
function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        onClick={() => {
          state.open = !open;
          setOpen(!open);
        }}
        data-testid="toggle-store"
      >
        Toggle store
      </button>
      {open && <PluginStorePage workspacePath="/fixture/project" onManageInstalled={() => {}} />}
    </>
  );
}
createRoot(document.getElementById("root")).render(
  <PlatformProvider
    platform={{
      platform: "linux",
      openExternal: () => {
        throw new Error("Unexpected navigation");
      },
    }}
  >
    <ServiceProvider services={services}>
      <TabStoreProvider>
        <TooltipProvider>
          <ZCodeIntlProvider initialLocale={locale}>
            <Fixture />
          </ZCodeIntlProvider>
        </TooltipProvider>
      </TabStoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
