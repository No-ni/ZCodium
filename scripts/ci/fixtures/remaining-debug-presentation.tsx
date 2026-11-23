import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Timeline } from "vis-timeline/standalone";
import { ExecutionGanttPanel } from "../../../apps/zcode-cli/packages/debug/src/presentation/index.js";
import type { TraceSpan } from "../../../apps/zcode-cli/packages/debug/src/shared.js";
import "../../../apps/zcode-cli/packages/debug/src/styles.css";

const lifecycle: string[] = [];
Object.assign(window, { fixtureLifecycle: lifecycle });
const on = Timeline.prototype.on,
  off = Timeline.prototype.off,
  destroy = Timeline.prototype.destroy;
Timeline.prototype.on = function (event, listener) {
  if (event === "select" && listener.name === "handleSelect") lifecycle.push("select:on");
  return on.call(this, event, listener);
};
Timeline.prototype.off = function (event, listener) {
  if (event === "select" && listener?.name === "handleSelect") lifecycle.push("select:off");
  return off.call(this, event, listener);
};
Timeline.prototype.destroy = function () {
  lifecycle.push("destroy");
  return destroy.call(this);
};

const initial: TraceSpan[] = [
  {
    id: "first",
    traceId: "fixture",
    source: "eventlog",
    lane: "tool",
    label: "Fixture Alpha",
    startAt: "2026-11-22T00:00:00.000Z",
    endAt: "2026-11-22T00:00:01.000Z",
    status: "ok",
  },
];
function Fixture() {
  const [mounted, setMounted] = useState(true),
    [spans, setSpans] = useState(initial);
  return (
    <>
      <button data-testid="toggle" onClick={() => setMounted((value) => !value)}>
        Toggle
      </button>
      <button
        data-testid="update"
        onClick={() => setSpans([{ ...initial[0]!, id: "second", label: "Fixture Beta" }])}
      >
        Update
      </button>
      <button
        data-testid="escape-label"
        onClick={() =>
          setSpans([
            {
              ...initial[0]!,
              id: "escaped",
              label: '<img src="/fixture-missing" onerror="window.fixtureInjected=1">',
            },
          ])
        }
      >
        Escape label
      </button>
      {mounted ? <ExecutionGanttPanel spans={spans} traceId="fixture" /> : null}
    </>
  );
}
document.body.style.overflow = "scroll";
createRoot(document.getElementById("root")!).render(<Fixture />);
