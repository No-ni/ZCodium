import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { Button } from "../src/components/ui/button.js";
import { ChatPromptEditor } from "../src/prompt-editor/ChatPromptEditor.js";
import {
  SidePaneFullViewConversationHost,
  useSidePaneFullView,
  useConversationPanePresentation,
  SidePaneFullViewToggleButton,
} from "../src/side-pane-full-view/index.js";
import type { FloatingAnchor } from "../src/side-pane-full-view/contract.js";
import "../src/styles.css";

(
  globalThis as typeof globalThis & { __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean }
).__ZCODE_RENDERER_DISABLE_LOGGING__ = true;
const noopSubscription = () => ({ dispose() {} });
const services = {
  settingService: {
    async get() {
      return {};
    },
    async update() {},
  },
  broadcastService: { async send() {}, onMessage: noopSubscription },
  clientConfigService: {
    async getSnapshot() {
      return { pluginStoreOrder: null };
    },
  },
  zcodeAgentService: {},
  zcodeSessionService: {},
  botsService: {},
} as unknown as IServiceAccessor;
const platform = { onSettingsChanged: () => () => {} } as unknown as IPlatformService;
function Providers({ children }: { children: ReactNode }) {
  return (
    <PlatformProvider platform={platform}>
      <ServiceProvider services={services}>
        <TabStoreProvider>
          <ZCodeIntlProvider initialLocale="en-US">
            <TooltipProvider>{children}</TooltipProvider>
          </ZCodeIntlProvider>
        </TabStoreProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}
function FixtureConversation({
  owner,
  focus,
  blocking,
  turn,
  running,
}: {
  owner: string;
  focus: boolean;
  blocking: string | null;
  turn: number;
  running: boolean;
}) {
  const presentation = useConversationPanePresentation();
  const dockRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [mounts] = useState(() => Math.random().toString(36).slice(2));
  const floating = presentation.presentation === "floating";
  useEffect(() => {
    if (focus && floating)
      presentation.reportFloatingStatus({
        running,
        blockingInteractionId: blocking,
        ownerKey: owner,
        latestTurn: {
          turnKey: `turn-${turn}`,
          running,
          answer: running ? null : { rowId: turn, text: `Complete answer ${turn} for ${owner}` },
        },
      });
  }, [blocking, focus, floating, owner, presentation, running, turn]);
  useEffect(() => {
    if (!focus || !floating || !dockRef.current) return;
    const dock = dockRef.current;
    const sync = () => presentation.reportComposerDockHeight(dock.getBoundingClientRect().height);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(dock);
    return () => observer.disconnect();
  }, [focus, floating, presentation.reportComposerDockHeight]);
  return (
    <section
      data-focused={focus ? "true" : "false"}
      aria-label={`Pane ${owner}`}
      className="relative flex h-full min-h-0 flex-col bg-background"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <h2 className="text-ui-base font-semibold">Conversation {owner}</h2>
        {Array.from({ length: 15 }, (_, index) => (
          <p key={index} className="py-2 text-ui-base">
            Synthetic message {index + 1}; owner {owner}.
          </p>
        ))}
      </div>
      <div ref={dockRef} className={floating ? "shrink-0" : "shrink-0 p-4"}>
        {blocking ? (
          <div role="alert" className="rounded-xl border border-border bg-card p-4 text-ui-base">
            Permission required {blocking}
          </div>
        ) : null}
        <div style={blocking ? { display: "none" } : undefined}>
          <ChatPromptEditor
            workspacePath={`/fixture/full-view/${owner}`}
            taskId={null}
            layout={floating ? "inline" : "stacked"}
            submitLabel="Keep draft"
            placeholder={`Draft ${owner}`}
            inputTestId={focus ? "v4-composer-input" : `fixture-input-${owner}`}
            syncInitialValueOnMount={false}
            onChange={setText}
            onSubmit={() => false}
            leadingActions={
              <Button type="button" size="sm">
                Mode
              </Button>
            }
          />
        </div>
        <output aria-label={`Draft state ${owner}`} className="sr-only">
          {text}
        </output>
        <output aria-label={`Mount ${owner}`} className="sr-only">
          {mounts}
        </output>
      </div>
    </section>
  );
}
function Fixture() {
  const [open, setOpen] = useState(true);
  const [desktop, setDesktop] = useState(true);
  const [owner, setOwner] = useState("a");
  const [focused, setFocused] = useState("a");
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<FloatingAnchor>("bottom-right");
  const [turn, setTurn] = useState(1);
  const [running, setRunning] = useState(false);
  const [blocking, setBlocking] = useState<string | null>(null);
  const controller = useSidePaneFullView({
    workspacePath: "/fixture/full-view",
    workspaceIdentity: `fixture:${owner}`,
    ownerId: owner,
    isSidePaneOpen: open,
    enabled: desktop,
  });
  const full = controller.fullView;
  const mode = !full ? "normal" : full.surface === "conversation" ? "conversation" : "floating";
  const toggle = useCallback(() => {
    if (!open) {
      setOpen(true);
      controller.enter();
    } else controller.toggle();
  }, [open, controller]);
  return (
    <main className="h-screen min-h-0 bg-background text-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <h1 className="text-ui-base font-semibold">Full view acceptance fixture</h1>
        <Button onClick={toggle}>Toggle full view</Button>
        <Button
          onClick={() => {
            controller.exit();
            setOpen(!open);
          }}
        >
          Toggle panel
        </Button>
        <Button onClick={() => controller.setSurface("conversation")}>Conversation surface</Button>
        <Button onClick={() => controller.setSurface("side-pane")}>Side surface</Button>
        <Button onClick={() => setOwner(owner === "a" ? "b" : "a")}>Switch owner</Button>
        <Button onClick={() => setFocused(focused === "a" ? "b" : "a")}>Switch pane focus</Button>
        <Button onClick={() => setDesktop(!desktop)}>Toggle desktop support</Button>
        <Button
          onClick={() => {
            setTurn(turn + 1);
            setRunning(false);
          }}
        >
          Fast answer
        </Button>
        <Button onClick={() => setRunning(!running)}>Toggle running</Button>
        <Button onClick={() => setBlocking(blocking ? null : `request-${turn}`)}>
          Toggle permission
        </Button>
        <output aria-label="Full view state" className="text-ui-sm">
          {owner} {mode} {full?.floating ?? "none"} {anchor}
        </output>
      </div>
      <div className="relative min-h-0 p-2" style={{ height: "calc(100vh - 100px)" }}>
        <div className="flex h-full min-h-0 gap-1">
          <div className="h-full min-w-0" style={{ width: "52%" }}>
            <SidePaneFullViewConversationHost
              mode={mode}
              floating={full?.floating ?? "collapsed"}
              anchor={anchor}
              scopeKey={owner}
              slotElement={slot}
              onFloatingChange={controller.setFloating}
              onAnchorChange={setAnchor}
              onOpenConversation={() => controller.setSurface("conversation")}
            >
              <div className="relative flex h-full min-h-0">
                {["a", "b"].map((pane) => (
                  <div
                    key={pane}
                    className={
                      mode === "floating"
                        ? pane === focused
                          ? "absolute inset-0"
                          : "invisible absolute inset-0"
                        : "w-1/2 min-w-0 border border-border"
                    }
                  >
                    <FixtureConversation
                      owner={pane}
                      focus={pane === focused}
                      blocking={pane === focused ? blocking : null}
                      turn={turn}
                      running={running}
                    />
                  </div>
                ))}
              </div>
            </SidePaneFullViewConversationHost>
          </div>
          <div
            className={
              full
                ? "absolute inset-2 z-0 flex flex-col border border-border bg-background"
                : "flex min-h-0 flex-1 flex-col border border-border"
            }
            style={{ ...(full ? { inset: 8 } : {}), ...(!open ? { visibility: "hidden" } : {}) }}
          >
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
              <Button onClick={() => controller.setSurface("conversation")}>
                Conversation tab
              </Button>
              <Button onClick={() => controller.setSurface("side-pane")}>Preview tab</Button>
              {desktop ? (
                <SidePaneFullViewToggleButton active={full !== null} onToggle={toggle} />
              ) : null}
            </div>
            <div ref={setSlot} className="min-h-0 flex-1 bg-surface p-4 text-ui-base">
              Synthetic document preview. Both conversation panes stay mounted.
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <Providers>
    <Fixture />
  </Providers>,
);
