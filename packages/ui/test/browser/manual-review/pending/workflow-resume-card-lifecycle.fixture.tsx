import { Component, StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ResumeWorkflowRunToolCallBlock } from "@/ToolCallBlocks/renderers/resume-workflow-run.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import "@/styles.css";

declare global {
  interface Window {
    workflowFixtureErrors: string[];
    workflowFixtureOpens: unknown[];
  }
}
window.workflowFixtureErrors = [];
window.workflowFixtureOpens = [];
const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;

class RenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    window.workflowFixtureErrors.push(error.message);
  }
  render() {
    return this.state.failed ? (
      <p data-testid="fixture-render-error">Fixture render failed</p>
    ) : (
      this.props.children
    );
  }
}

function EmptyNestedTool() {
  return null;
}

function Fixture() {
  const [joined, setJoined] = useState(query.get("initial") === "joined");
  const [finished, setFinished] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const context: ToolCallBlockRenderContext = {
    nestedToolRenderer: EmptyNestedTool,
    workspacePath: "fixture-workspace",
    viewerSource: null,
    rawFileSummaries: [],
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: true,
      showKind: true,
    },
    isRunning: false,
    statusLabel: "Fixture complete",
    childToolList: null,
    forceOpen: true,
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: "E2E_WRC_TOOL",
        toolName: "ResumeWorkflowRun",
        kind: "other",
        input: { runId: "E2E_WRC_RUN" },
        status: "completed",
        output: legacy ? "E2E_WRC_LEGACY_OUTPUT" : "E2E_WRC_RESUME_OUTPUT",
        raw: legacy
          ? undefined
          : { display: { kind: "resume_workflow_run", runId: "E2E_WRC_RUN" } },
      },
    },
    ...(joined
      ? {
          workflowRun: {
            runId: "E2E_WRC_RUN",
            toolCallId: "E2E_WRC_CREATE_TOOL",
            status: finished ? "completed" : "running",
            nodesSettled: finished ? 3 : 1,
            nodesTotal: 3,
          },
          onOpenWorkflowRun(request) {
            window.workflowFixtureOpens.push(request);
          },
        }
      : {}),
  };
  return (
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale="en-US">
        <main className="min-h-dvh bg-background p-4 text-foreground text-ui-base">
          <nav className="mb-4 flex flex-wrap gap-3">
            <button type="button" onClick={() => setJoined(true)}>
              Join run
            </button>
            <button type="button" onClick={() => setJoined(false)}>
              Detach run
            </button>
            <button type="button" onClick={() => setFinished(true)}>
              Finish run
            </button>
            <button type="button" onClick={() => setLegacy(true)}>
              Legacy output
            </button>
          </nav>
          <section data-testid="fixture-tool" data-state={joined ? "joined" : "unjoined"}>
            <RenderBoundary>
              <ResumeWorkflowRunToolCallBlock key="E2E_WRC_TOOL" {...context} />
            </RenderBoundary>
          </section>
        </main>
      </ZCodeIntlProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
