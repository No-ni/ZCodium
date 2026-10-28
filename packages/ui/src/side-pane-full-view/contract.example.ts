import type { SidePaneFullViewState, SidePaneFullViewHostMode } from "./contract.js";

export function exampleSidePaneFullView(
  state: SidePaneFullViewState | null,
): SidePaneFullViewHostMode {
  return !state ? "normal" : state.surface === "conversation" ? "conversation" : "floating";
}
