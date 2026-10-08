import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { RootStartupLoading } from "../../../packages/ui/src/root/RootStartupLoading.js";
import { GlobalDatabaseStartupLoading } from "../../../packages/ui/src/root/GlobalDatabaseStartupLoading.js";
import { StartupPresentationReady } from "../../../packages/ui/src/root/StartupPresentationReady.js";
import { AppErrorBoundary } from "../../../packages/ui/src/ErrorBoundary.js";
import { Button } from "../../../packages/ui/src/components/ui/button.js";
import { finishStartupPresentation } from "@zcode/ui/startup-presentation";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "normal";
const startedAt = Date.now();
function Crash() {
  throw new Error("Preview render failure");
}

function Workspace() {
  const [created, setCreated] = useState(false);
  return (
    <main className="flex h-dvh bg-background text-foreground" aria-label="预览工作区">
      <StartupPresentationReady />
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-sidebar p-4 sm:flex">
        <p className="mb-8 text-ui-base font-semibold">ZCodium</p>
        <Button onClick={() => setCreated(true)}>新建任务</Button>
        <p className="mt-8 text-ui-caption text-foreground-subtle">工作区</p>
        <p className="mt-3 rounded-lg bg-hover px-3 py-2 text-ui-base">启动效果预览</p>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-border px-6 py-4 text-ui-base">启动效果预览</header>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6">
          <img src="/logo/icons/512x512.png" width="48" height="48" alt="" />
          <h1 className="text-ui-xl font-medium">{created ? "已创建预览任务" : "准备好开始了"}</h1>
          <p className="text-center text-ui-base text-foreground-subtle">
            启动已完成，你可以继续工作。
          </p>
          <div className="mt-4 w-full max-w-xl rounded-2xl border border-border bg-surface p-5 text-ui-base text-foreground-subtlest">
            描述你想完成的任务…
          </div>
        </div>
      </section>
    </main>
  );
}

function Fixture() {
  const [phase, setPhase] = useState("database");
  window.startupPreview = { phase: setPhase, finish: finishStartupPresentation };
  useEffect(() => {
    if (params.has("manual")) return;
    const slow = scenario === "slow";
    const duration = scenario === "fast" ? 100 : slow ? 6500 : 2100;
    const timers = [
      setTimeout(() => setPhase("workspace"), duration * 0.6),
      setTimeout(
        () => setPhase(scenario === "failed" || scenario === "migration" ? scenario : "ready"),
        duration,
      ),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);
  useEffect(() => {
    window.parent.postMessage({ type: "startup-preview-phase", phase }, location.origin);
  }, [phase]);
  if (phase === "ready") return <Workspace />;
  if (phase === "crashed") return <Crash />;
  if (phase === "workspace" || phase === "directory-failed")
    return (
      <RootStartupLoading label="正在准备工作区" busy={phase !== "directory-failed"}>
        {phase === "directory-failed" ? (
          <>
            <p role="alert">无法创建预览工作区</p>
            <Button onClick={() => setPhase("workspace")}>重试</Button>
          </>
        ) : null}
      </RootStartupLoading>
    );
  const state = {
    schemaVersion: 1,
    startupId: "preview-startup",
    attemptId: "preview-attempt",
    sequence: 1,
    startedAt,
    updatedAt: Date.now(),
    phase: phase === "failed" ? "failed" : "starting",
    ...(phase === "failed" ? { errorCode: "storage_full", failedPhase: "starting" } : {}),
    ...(phase === "migration"
      ? {
          migration: { kind: "upgrade", executedCount: 1, committedCount: 0 },
          databasePhase: "migrating",
        }
      : {}),
    disk: [],
  };
  return (
    <GlobalDatabaseStartupLoading
      state={state}
      onRetry={() => setPhase("workspace")}
      onCopy={async () => {}}
      onExit={() => setPhase("ready")}
    />
  );
}
createRoot(document.getElementById("root")).render(
  <AppErrorBoundary>
    <ZCodeIntlProvider initialLocale="zh-CN">
      <Fixture />
    </ZCodeIntlProvider>
  </AppErrorBoundary>,
);
