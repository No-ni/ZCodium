import { StrictMode, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { usePluginUiRowDisposition } from "@/plugin-ui/adapters/usePluginUiRowDisposition.js";
import { usePublishPluginUiInstanceDerivation } from "@/plugin-ui/adapters/usePublishPluginUiInstanceDerivation.js";
import {
  deriveLogicalUiInstances,
  type PluginUiRowDisposition,
} from "@/plugin-ui/domain/pluginUiInstancePolicy.js";
import {
  createPluginUiInstancePublisher,
  getPluginUiRowDisposition,
  subscribePluginUiInstances,
} from "@/plugin-ui/app/pluginUiInstanceStore.js";
import {
  getPluginUiManualPin,
  setPluginUiManualPin,
  subscribePluginUiDisclosure,
} from "@/plugin-ui/app/pluginUiDisclosureStore.js";

const counts = Array.from({ length: 12 }, () => 0);
const tools: ToolCallRow[] = Array.from({ length: 12 }, (_, index) => ({
  kind: "toolCall",
  rowId: index + 1,
  turnId: "turn",
  createdAt: 1,
  createdAtSeq: index + 1,
  toolCallId: `call-${index}`,
  toolName: "mcp__fixture__view",
  status: "success",
  inputText: "{}",
  display: {
    kind: "mcp_tool",
    serverName: "fixture",
    toolName: "view",
    ui: { pluginId: "fixture", resourceUri: "ui://fixture/view" },
  },
}));
let currentSession = "session-a";
let publisher = createPluginUiInstancePublisher(currentSession);
let rows: ConversationRow[] = [...tools];
function publish() {
  publisher.set(deriveLogicalUiInstances(rows));
}
publish();

// 仅夹具保留改前订阅，同输入/同浏览器复现基线，不切换生产 hook。
const useDisposition = new URLSearchParams(location.search).has("reference")
  ? function useOriginalDisposition(session: string, id: string) {
      return useSyncExternalStore(
        subscribePluginUiInstances,
        () => getPluginUiRowDisposition(session, id),
        () => undefined,
      );
    }
  : usePluginUiRowDisposition;

function Card({ index, session }: { index: number; session: string }) {
  const id = `call-${index}`;
  const disposition = useDisposition(session, id);
  const pin = useSyncExternalStore(
    subscribePluginUiDisclosure,
    () => getPluginUiManualPin(session, id),
    () => undefined,
  );
  counts[index]!++;
  return (
    <section id={`card-${index}`}>
      <output>{JSON.stringify(disposition) ?? "absent"}</output>
      <button onClick={() => setPluginUiManualPin(session, id, !(pin ?? false))}>
        {pin ? "Unpin" : "Pin"}
      </button>
    </section>
  );
}
let setSession!: (value: string) => void;
let setVisible!: (value: boolean) => void;
function App() {
  const [session, updateSession] = useState(currentSession);
  const [visible, updateVisible] = useState(true);
  setSession = updateSession;
  setVisible = updateVisible;
  return (
    <main>
      {visible
        ? tools.map((_, index) => <Card key={index} index={index} session={session} />)
        : null}
    </main>
  );
}
flushSync(() => createRoot(document.getElementById("root")!).render(<App />));

interface TimelineInput {
  id: string;
  session: string;
  tag: string;
  revision?: number;
  visible?: boolean;
}

function TimelineFixture({ session, tag, revision = 0, visible = true }: TimelineInput) {
  const derivation = useMemo(
    () =>
      deriveLogicalUiInstances([
        {
          ...tools[0]!,
          display: {
            ...tools[0]!.display!,
            ui: {
              pluginId: "fixture",
              resourceUri: `ui://fixture/${tag}`,
            },
          },
        },
        {
          kind: "assistantText",
          rowId: 100,
          turnId: "turn",
          createdAt: 1,
          createdAtSeq: 100,
          state: "streaming",
          text: `text ${revision}`,
        },
      ]),
    [tag, revision],
  );
  usePublishPluginUiInstanceDerivation(session, derivation);
  return visible ? <LifecycleCard session={session} /> : null;
}

function LifecycleCard({ session }: { session: string }) {
  const disposition = usePluginUiRowDisposition(session, "call-0");
  return <output data-lifecycle-session={session}>{disposition?.key ?? "absent"}</output>;
}

const lifecycleContainer = document.createElement("div");
document.body.append(lifecycleContainer);
const lifecycleRoot = createRoot(lifecycleContainer);
const lifecycleEvents: Record<string, (string | null)[]> = {};
const unsubscribeLifecycle = subscribePluginUiInstances(() => {
  for (const [session, events] of Object.entries(lifecycleEvents))
    events.push(getPluginUiRowDisposition(session, "call-0")?.key ?? null);
});

const api = {
  lifecycle: {
    render(inputs: TimelineInput[]) {
      for (const input of inputs) lifecycleEvents[input.session] ??= [];
      flushSync(() =>
        lifecycleRoot.render(
          <StrictMode>
            {inputs.map((input) => (
              <TimelineFixture key={input.id} {...input} />
            ))}
          </StrictMode>,
        ),
      );
    },
    snapshot(session: string) {
      return getPluginUiRowDisposition(session, "call-0") ?? null;
    },
    events(session: string) {
      return [...(lifecycleEvents[session] ?? [])];
    },
    clearEvents() {
      for (const session of Object.keys(lifecycleEvents)) lifecycleEvents[session] = [];
    },
    unmount() {
      flushSync(() => lifecycleRoot.unmount());
      unsubscribeLifecycle();
    },
  },
  counts: () => [...counts],
  stream(times: number) {
    for (let index = 0; index < times; index++)
      flushSync(() => {
        rows = [
          ...tools,
          {
            kind: "assistantText",
            rowId: 100,
            turnId: "turn",
            createdAt: 1,
            createdAtSeq: 100,
            state: "streaming",
            text: `text ${index}`,
          },
        ];
        publish();
      });
  },
  patch(patch: Partial<PluginUiRowDisposition>) {
    const derivation = deriveLogicalUiInstances(rows);
    const previous = getPluginUiRowDisposition(currentSession, "call-0")!;
    flushSync(() =>
      publisher.set({
        ...derivation,
        byToolCallId: { ...derivation.byToolCallId, "call-0": { ...previous, ...patch } },
      }),
    );
  },
  age() {
    rows = [
      ...tools,
      ...Array.from(
        { length: 3 },
        (_, index): ConversationRow => ({
          kind: "assistantText",
          rowId: 200 + index,
          turnId: `new-${index}`,
          createdAt: 1,
          createdAtSeq: 200 + index,
          text: "new turn",
          state: "complete",
        }),
      ),
    ];
    flushSync(publish);
  },
  remove() {
    rows = [];
    flushSync(publish);
  },
  restore() {
    rows = [...tools];
    flushSync(publish);
  },
  session(value: string) {
    publisher.dispose();
    publisher = createPluginUiInstancePublisher(value);
    currentSession = value;
    flushSync(() => setSession(value));
  },
  visible(value: boolean) {
    flushSync(() => setVisible(value));
  },
};
declare global {
  interface Window {
    pluginDisposition: typeof api;
  }
}
window.pluginDisposition = api;
