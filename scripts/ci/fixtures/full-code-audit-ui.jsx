import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useWorkflowRunSave } from "../../../packages/ui/src/project-workflow/useWorkflowRunSave.ts";
import { ImagePreviewDialog } from "../../../packages/ui/src/components/ai-elements/image-preview-dialog.tsx";
import { PlatformProvider } from "../../../packages/ui/src/hooks/usePlatform.tsx";
import { saveBrowserFile } from "../../../packages/web/src/platform/saveBrowserFile.ts";
import { App as StreamApp } from "../../../packages/stream-animate/src/App.tsx";
import { TrendPanels } from "../../../packages/e2e-report/src/viewer/ChartPanels.tsx";
import { Chart } from "chart.js";
import { App as DocsApp } from "../../../apps/dev-docs/src/App.tsx";

const mode = new URLSearchParams(location.search).get("mode");
Chart.defaults.animation = false;
const remote = mode === "workflow-remote";
const makeRun = (id) => ({
  id,
  model: "audit-model-" + id,
  status: "completed",
  createdAt: "2026-11-06T01:00:00.000Z",
  completedAt: "2026-11-06T01:00:01.000Z",
  apiKeySource: "provided",
  baseUrl: "",
  files: { raw: "", summary: "", responseText: "" },
  metrics: null,
  outputPreview: "",
  error: null,
  reasoningEffort: "high",
  thinkingEnabled: false,
});
const runs = [makeRun("A"), makeRun("B")];
let releaseA;
const pendingA = new Promise((resolve) => {
  releaseA = resolve;
});
window.auditUiFixture = {
  launches: [],
  resolutions: [],
  detailRequests: [],
  runs,
  releaseA,
  resolution: {
    rpcReady: true,
    isRemoteTarget: remote,
    remoteSessionId: remote ? "attachment-a" : null,
    services: {
      zcodeAgentService: { findSavedWorkflowForRun: async () => ({}) },
      windowProjectDirectory: {
        projectService: {
          resolveSessionDirectories: async (request) => {
            window.auditUiFixture.resolutions.push(request);
            return { projectId: "resolved-project-a" };
          },
        },
      },
    },
  },
  fetchRun: async (id) => {
    window.auditUiFixture.detailRequests.push(id);
    if (id === "A") await pendingA;
    return runs.find((run) => run.id === id);
  },
  chartProbe: (index) => {
    const canvas = document.querySelectorAll("canvas")[index];
    const chart = Chart.getChart(canvas);
    const point = chart?.getDatasetMeta(0).data[1]?.getCenterPoint();
    const rect = canvas?.getBoundingClientRect();
    return {
      x: rect && point ? rect.x + point.x : null,
      y: rect && point ? rect.y + point.y : null,
      tooltip: chart?.tooltip?.body?.flatMap((item) => item.lines).join("\n"),
    };
  },
};
if (mode?.startsWith("docs")) {
  const nativeFetch = window.fetch.bind(window);
  let releaseOld;
  const pendingOld = new Promise((resolve) => {
    releaseOld = resolve;
  });
  window.auditUiFixture.docsRequests = 0;
  window.auditUiFixture.releaseDocsOld = releaseOld;
  window.fetch = async (input, options) => {
    if (!String(input).startsWith("/api/dev/stdio-traffic")) return nativeFetch(input, options);
    const request = ++window.auditUiFixture.docsRequests;
    if (mode === "docs-race" && request === 1) await pendingOld;
    const raw = request === 1 ? "audit-old" : "audit-new";
    const data =
      mode === "docs-race"
        ? {
            status: "ready",
            logDir: "/audit/docs-stdio",
            records: [
              {
                index: request,
                record: { ts: "2026-11-06T01:00:00Z", direction: "app-to-agent", raw },
              },
            ],
          }
        : { status: "missing", logDir: "/audit/docs-stdio", records: [] };
    return { ok: true, json: async () => data };
  };
}

if (mode === "stream-cross") {
  const running = { ...makeRun("A"), status: "running" };
  let lists = 0,
    details = 0,
    releaseList;
  const oldList = new Promise((resolve) => {
    releaseList = resolve;
  });
  window.auditUiFixture.releaseStreamList = () => releaseList([running, makeRun("B")]);
  window.auditUiFixture.fetchRuns = () => (++lists === 1 ? Promise.resolve([running]) : oldList);
  window.auditUiFixture.fetchRun = async () => (++details === 1 ? running : makeRun("A"));
}

if (mode === "stream-initial") {
  let lists = 0,
    rejectInitial;
  const initial = new Promise((_, reject) => {
    rejectInitial = reject;
  });
  window.auditUiFixture.releaseStreamInitial = () =>
    rejectInitial(new Error("synthetic stale initial failure"));
  window.auditUiFixture.fetchRuns = () =>
    ++lists === 1 ? initial : Promise.resolve([makeRun("B")]);
  window.auditUiFixture.fetchRun = async () => makeRun("B");
}

function ChartFixture() {
  const series = (label, value, unit) => ({
    label,
    color: "#123456",
    unit,
    points: [1, 3, 5].map((elapsedSeconds) => ({
      capturedAt: "2026-11-06T01:00:00Z",
      elapsedSeconds,
      label: String(elapsedSeconds),
      value,
    })),
  });
  return (
    <>
      <style>{".chartBox {height: 300px; width: 350px}"}</style>
      <TrendPanels
        trends={{
          containerCpu: [series("CPU Total", 47.25, "%")],
          containerMemory: [series("Memory", 128, "MB")],
          processCpu: [],
          processMemory: [],
        }}
      />
    </>
  );
}

function WorkflowFixture() {
  const [result, setResult] = useState("");
  const controller = useWorkflowRunSave({
    runId: "audit-run",
    workspacePath: "/audit/shared",
    projectId: "known-project-a",
    hostId: remote ? "host-a" : "local",
    ...(remote
      ? {
          sessionId: "original-task",
          workspaceIdentity: "audit-remote-a",
          remoteSessionId: "attachment-a",
        }
      : {}),
  });
  return (
    <>
      <button
        onClick={() =>
          void controller
            .launch({ name: "audit-workflow", scope: "project" }, {})
            .then(() => setResult("launched"))
        }
      >
        再次运行
      </button>
      <output>{result}</output>
    </>
  );
}

function ImageFixture() {
  const [open, setOpen] = useState(false);
  return (
    <PlatformProvider platform={{ saveFile: saveBrowserFile }}>
      <button onClick={() => setOpen(true)}>预览图片</button>
      <ImagePreviewDialog
        open={open}
        onOpenChange={setOpen}
        initialIndex={0}
        items={[
          {
            src: location.origin + "/audit-image.svg",
            alt: "audit-image",
            mediaType: "image/svg+xml",
          },
        ]}
      />
    </PlatformProvider>
  );
}

const root = createRoot(document.getElementById("root"));
window.auditUiFixture.unmount = () => root.unmount();
root.render(
  mode?.startsWith("workflow") ? (
    <WorkflowFixture />
  ) : mode === "image" ? (
    <ImageFixture />
  ) : mode === "chart" ? (
    <ChartFixture />
  ) : mode?.startsWith("docs") ? (
    <DocsApp />
  ) : (
    <StreamApp />
  ),
);
