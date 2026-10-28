import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { IModelSelectionService, IServiceAccessor, ModelSelectionView } from "@zcode/services";
import type { IPlatformService, ModelSelection } from "@zcode/shared";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { Button } from "../src/components/ui/button.js";
import { ModelConfigSelect } from "../src/ModelConfigSelect.js";
import { V4ComposerModelControls } from "../src/v4/composer/V4ComposerToolbar.js";
import { useDraftConfigControl } from "../src/v4/composer/useDraftConfigControl.js";
import { createComposerSubmissionConfig } from "../src/v4/composer/composerSubmissionConfig.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
} from "../src/v4/composer/composerDraftStore.js";
import type { V4ComposerConfigPicker } from "../src/v4/composer/configPickerState.js";
import "../src/styles.css";

(
  globalThis as typeof globalThis & { __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean }
).__ZCODE_RENDERER_DISABLE_LOGGING__ = true;

const paths = ["/fixture/menu-left", "/fixture/menu-right"];
const initialSelection: ModelSelection = {
  providerId: "fixture-api",
  modelId: "Model A",
  options: { reasoningLevel: "high" },
};
const noopSubscription = () => ({ dispose() {} });
const services = {
  settingService: {
    async get() {
      return {};
    },
    async update() {},
  },
  broadcastService: { async send() {}, onMessage: noopSubscription },
  zcodeSessionService: {},
  zcodeAgentService: {},
  botsService: {},
} as unknown as IServiceAccessor;
const platform = { onSettingsChanged: () => () => {} } as unknown as IPlatformService;

function model(modelId: string, values: string[]) {
  return {
    modelId,
    config: {
      properties: { inputFormat: { supportsImage: true } },
      optionSpecs: { reasoningLevel: { values } },
    },
  };
}
const providers = [
  {
    providerId: "fixture-api",
    providerName: "Fixture API",
    config: { api: { type: "openai" }, access: { type: "api-key" } },
    models: [
      model("Model A", ["low", "high"]),
      model("Model B", ["off", "medium", "high"]),
      model("Fixed model", ["off"]),
      model("No effort model", []),
    ],
  },
  {
    providerId: "fixture-long",
    providerName: "Very long provider name for narrow viewport and keyboard navigation",
    config: { api: { type: "openai" }, access: { type: "api-key" } },
    models: Array.from({ length: 18 }, (_, index) =>
      model(`Long model name ${index + 1} with detailed capability labels`, ["minimal", "high"]),
    ),
  },
] as unknown as ModelSelectionView["providers"];

function createFixtureSource() {
  let revision = 1;
  let hold = false;
  let empty = false;
  const pending = new Set<() => void>();
  const listeners = new Set<(view: ModelSelectionView) => void>();
  const project = (selection?: ModelSelection | null): ModelSelectionView => ({
    revision,
    providers: empty ? [] : providers,
    effectiveSelection: selection ?? undefined,
  });
  const service = {
    getView(input?: { selection: ModelSelection | null }) {
      const read = () => project(input?.selection);
      if (!hold) return Promise.resolve(read());
      return new Promise<ModelSelectionView>((resolve) => pending.add(() => resolve(read())));
    },
    onDidChange(listener: (view: ModelSelectionView) => void) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
  } as IModelSelectionService;
  return {
    service,
    setHold(value: boolean) {
      hold = value;
      if (!hold) {
        for (const resolve of pending) resolve();
        pending.clear();
      }
    },
    setEmpty(value: boolean) {
      empty = value;
      revision += 1;
      for (const listener of listeners) listener(project());
    },
  };
}

for (const path of paths) {
  clearV4ComposerDraft(path, undefined, "__draft__");
  persistV4ComposerDraft(path, undefined, "__draft__", {
    text: "",
    mode: "build",
    modelSelection: initialSelection,
  });
  const store = useZCodeSessionStore.getState();
  store.setConfigOptions(path, [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "build",
      options: [{ value: "build", name: "Build" }],
    },
  ]);
  store.setConfigOptionsStatus(path, "ready");
  store.setSlashCommands(path, [
    { id: "fixture", name: "fixture", description: "Synthetic fixture" },
  ] as never);
}

function Providers({ children, locale }: { children: ReactNode; locale: "en-US" | "zh-CN" }) {
  return (
    <PlatformProvider platform={platform}>
      <ServiceProvider services={services}>
        <TabStoreProvider>
          <ZCodeIntlProvider initialLocale={locale}>
            <TooltipProvider>{children}</TooltipProvider>
          </ZCodeIntlProvider>
        </TabStoreProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}

function FixturePane({
  path,
  name,
  source,
}: {
  path: string;
  name: string;
  source: ReturnType<typeof createFixtureSource>;
}) {
  const owner = useDraftConfigControl({
    workspacePath: path,
    sessionId: null,
    agentStartupAllowed: false,
    modelSelectionService: source.service,
  });
  const state = owner.modelSelectionRead.state;
  const view = state.status === "ready" ? state.view : null;
  const [picker, setPicker] = useState<V4ComposerConfigPicker | null>(null);
  const [frozen, setFrozen] = useState<ReturnType<typeof createComposerSubmissionConfig>>(null);
  const staleRef = useRef<(() => void) | null>(null);
  const ready = createComposerSubmissionConfig(owner.draftConfig, view);
  return (
    <section
      role="region"
      aria-label={name}
      className="chat-composer-region min-w-0 rounded-xl border border-border bg-card p-3"
    >
      <h2 className="mb-2 text-ui-base font-semibold">{name}</h2>
      <div
        role="textbox"
        contentEditable
        suppressContentEditableWarning
        aria-label={`${name} input`}
        data-testid="v4-composer-input"
        className="min-h-16 rounded-md border border-input-border bg-input p-2 text-mobile-input-safe"
      />
      <div
        className="mt-2 flex min-w-0 flex-wrap items-center gap-1"
        data-testid={`${name}-toolbar`}
      >
        <V4ComposerModelControls
          workspacePath={path}
          modelSelectionView={view}
          modelSelectionState={state}
          modelSelectionReload={owner.modelSelectionRead.reload}
          sessionId={null}
          phase={null}
          draftMode
          draftConfig={owner.draftConfig}
          usage={null}
          disabled={false}
          activeConfigPicker={picker}
          onConfigPickerOpenChange={(slot, open) => setPicker(open ? slot : null)}
          onSelectModel={(provider, id) => owner.handleDraftSelectModel(provider, id)}
          onSelectThought={owner.handleDraftSelectThought}
          onSwitchMode={owner.handleDraftSwitchMode}
        />
        <Button
          onClick={() =>
            setFrozen(createComposerSubmissionConfig(owner.draftConfigRef.current, view))
          }
          disabled={!ready}
        >
          Freeze {name} submission
        </Button>
      </div>
      <output aria-label={`${name} selection`} className="mt-2 block break-all text-ui-sm">
        {state.status}: {JSON.stringify(owner.draftConfig.modelSelection)}
      </output>
      <output aria-label={`${name} frozen`} className="block break-all text-ui-sm">
        {frozen ? JSON.stringify(frozen) : "No frozen submission"}
      </output>
      <div className="mt-2 flex flex-wrap gap-1">
        <Button
          size="sm"
          onClick={() => {
            const context = { provider: "fixture-api", model: "Model A" };
            staleRef.current = () => owner.handleDraftSelectThought("low", context);
          }}
        >
          Capture old A event {name}
        </Button>
        <Button size="sm" onClick={() => staleRef.current?.()}>
          Deliver old A event {name}
        </Button>
        <Button size="sm" onClick={() => owner.handleDraftSelectModel("fixture-api", "Model B")}>
          Select B {name}
        </Button>
        <Button
          size="sm"
          onClick={() => owner.handleDraftSelectModel("fixture-api", "No effort model")}
        >
          Select no effort {name}
        </Button>
      </div>
    </section>
  );
}

function FixtureApp() {
  const source = useMemo(createFixtureSource, []);
  const params = new URLSearchParams(location.search);
  const locale = params.get("locale") === "zh-CN" ? "zh-CN" : "en-US";
  const [dark, setDark] = useState(params.get("theme") === "dark");
  const [empty, setEmpty] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [legacyValue, setLegacyValue] = useState("legacy/a");
  useEffect(() => {
    document.documentElement.className = dark ? "theme-zai-dark dark" : "theme-zai-light";
  }, [dark]);
  return (
    <Providers locale={locale}>
      <main className="h-full overflow-y-auto bg-background p-3 text-foreground">
        <h1 className="text-ui-lg font-semibold">Combined model menu acceptance fixture</h1>
        <p className="mb-3 text-ui-sm text-foreground-subtle">
          Real draft owner, target-view hook, Radix menu and submission freeze; synthetic services
          only.
        </p>
        <div className="mb-3 flex flex-wrap gap-2">
          <Button onClick={() => setDark(!dark)}>Toggle theme</Button>
          <Button onClick={() => source.setHold(true)}>Hold target reads</Button>
          <Button onClick={() => source.setHold(false)}>Release target reads</Button>
          <Button
            onClick={() => {
              source.setEmpty(!empty);
              setEmpty(!empty);
            }}
          >
            Toggle empty catalog
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <FixturePane path={paths[0]!} name="Left" source={source} />
          <FixturePane path={paths[1]!} name="Right" source={source} />
        </div>
        <section
          role="region"
          aria-label="Legacy model menu"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
        >
          <span className="text-ui-sm">Legacy model menu</span>
          <ModelConfigSelect
            modelGroups={[
              {
                key: "legacy",
                label: "Legacy provider",
                directItems: true,
                items: [
                  { key: "a", value: "legacy/a", name: "Legacy A" },
                  { key: "b", value: "legacy/b", name: "Legacy B" },
                ],
              },
            ]}
            normalizedValue={legacyValue}
            triggerLabel={legacyValue}
            showManageModelsAction={false}
            lockReasonMessage="Locked"
            isItemLocked={() => false}
            onValueChange={setLegacyValue}
            open={legacyOpen}
            onOpenChange={setLegacyOpen}
            focusSelectorOnClose={null}
          />
          <output aria-label="Legacy selection" className="text-ui-sm">
            {legacyValue}
          </output>
        </section>
      </main>
    </Providers>
  );
}

createRoot(document.getElementById("root")!).render(<FixtureApp />);
