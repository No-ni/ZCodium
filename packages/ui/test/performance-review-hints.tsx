import { StrictMode, type Ref } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  CodeBlockControlHint,
  CodeBlockTooltipScope,
} from "@/components/ai-elements/code-block-tooltip-scope.js";
import { Button } from "@/components/ui/button.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

type RefKind = "cleanup" | "legacy" | "object";
interface Config {
  mode: "scoped" | "fallback" | "direct";
  kind: RefKind;
  triggerKind: RefKind;
  strict: boolean;
  mounted: boolean;
  generation: number;
  prevent: boolean;
  revision: number;
}
const root = createRoot(document.getElementById("root")!);
const events: string[] = [];
const refs = new Map<string, Ref<HTMLButtonElement>>();
const live = new Map<string, HTMLButtonElement>();
let config: Config = {
  mode: "scoped",
  kind: "cleanup",
  triggerKind: "legacy",
  strict: false,
  mounted: true,
  generation: 0,
  prevent: false,
  revision: 0,
};

function trackedRef(key: string, kind: RefKind): Ref<HTMLButtonElement> {
  const previous = refs.get(key);
  if (previous) return previous;
  const assign = (node: HTMLButtonElement | null) => {
    events.push(`${key}:${node ? "attach" : "null"}`);
    if (node) live.set(key, node);
    else live.delete(key);
  };
  const ref: Ref<HTMLButtonElement> =
    kind === "object"
      ? {
          get current() {
            return live.get(key) ?? null;
          },
          set current(node) {
            assign(node);
          },
        }
      : (node) => {
          assign(node);
          if (node && kind === "cleanup")
            return () => {
              events.push(`${key}:cleanup`);
              live.delete(key);
            };
        };
  refs.set(key, ref);
  return ref;
}

function Fixture() {
  const button = (
    <Button
      id="hint-button"
      ref={trackedRef(`child-${config.generation}`, config.kind)}
      aria-describedby="existing-description"
      onPointerEnter={(event) => {
        events.push("pointerenter");
        if (config.prevent) event.preventDefault();
      }}
      onPointerLeave={() => {
        events.push("pointerleave");
      }}
      onPointerDown={() => {
        events.push("pointerdown");
      }}
      onFocus={(event) => {
        events.push("focus");
        if (config.prevent) event.preventDefault();
      }}
      onBlur={() => {
        events.push("blur");
      }}
      onKeyDown={(event) => {
        events.push(`keydown:${event.key}`);
      }}
      onClick={() => {
        events.push("click");
      }}
    >
      Action
    </Button>
  );
  const hint =
    config.mode === "direct" ? (
      <ControlHintTooltip
        title="Action hint"
        triggerRef={trackedRef(`trigger-${config.generation}`, config.triggerKind)}
      >
        {button}
      </ControlHintTooltip>
    ) : (
      <CodeBlockControlHint title="Action hint">{button}</CodeBlockControlHint>
    );
  return (
    <TooltipProvider>
      <button id="before">Before</button>
      <span id="existing-description">Existing description</span>
      {config.mounted ? (
        config.mode === "scoped" ? (
          <CodeBlockTooltipScope>{hint}</CodeBlockTooltipScope>
        ) : (
          hint
        )
      ) : null}
      <button id="after">After</button>
      <output id="revision">{config.revision}</output>
    </TooltipProvider>
  );
}

const api = {
  render(next: Partial<Config>) {
    config = { ...config, ...next };
    flushSync(() =>
      root.render(
        config.strict ? (
          <StrictMode>
            <Fixture />
          </StrictMode>
        ) : (
          <Fixture />
        ),
      ),
    );
  },
  snapshot: () => ({
    events: [...events],
    live: [...live.keys()],
    connected: [...live.values()].every((node) => node.isConnected),
  }),
};
declare global {
  interface Window {
    performanceReviewHints: typeof api;
  }
}
window.performanceReviewHints = api;
