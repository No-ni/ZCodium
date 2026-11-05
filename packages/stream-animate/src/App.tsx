import { useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig, RunSummary } from "@/shared/types";
import { Aggregates } from "@/client/Aggregates";
import {
  DEFAULT_FORM,
  createRun,
  fetchConfig,
  fetchRawLines,
  fetchRun,
  fetchRuns,
  type RunFormState,
} from "@/client/api";
import { FrameCharts } from "@/client/FrameChart";
import { RunForm } from "@/client/RunForm";
import { RunHistory } from "@/client/RunHistory";
import { RunSummaryPanel } from "@/client/RunSummaryPanel";

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [form, setForm] = useState<RunFormState>(DEFAULT_FORM);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  const [rawLines, setRawLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selectedRunIdRef = useRef(selectedRunId);
  selectedRunIdRef.current = selectedRunId;
  const selectedRequestRef = useRef(0);
  const runsRequestRef = useRef(0);
  const runsDetailVersionRef = useRef(0);
  const runDetailVersionsRef = useRef(new Map<string, number>());
  // 新选择等待读取时不展示另一 run 的旧摘要与原始输出。
  const displayedRun = selectedRun?.id === selectedRunId ? selectedRun : null;
  const displayedRawLines = displayedRun ? rawLines : [];

  const hasRunningRun = useMemo(() => runs.some((run) => run.status === "running"), [runs]);

  useEffect(() => {
    let current = true;
    // 初始列表复用刷新入口的序号守卫；config失败与列表失败分别裁决，避免旧列表错误污染新刷新。
    void refreshRuns();
    void fetchConfig()
      .then((nextConfig) => {
        if (!current) return;
        setConfig(nextConfig);
      })
      .catch((loadError: unknown) => {
        if (current) setError(toErrorMessage(loadError));
      });
    return () => {
      current = false;
      ++runsRequestRef.current;
    };
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRun(null);
      setRawLines([]);
      return;
    }
    void refreshSelectedRun(selectedRunId);
    return () => {
      // 选择切换或卸载使已经发出的详情与轮询结果失效。
      ++selectedRequestRef.current;
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (!hasRunningRun) {
      return;
    }
    let current = true;
    // 每批读取结束后再轮询，避免慢网络下不断发新请求，让所有回包都被最新序号守卫丢弃。
    const poll = async () => {
      await Promise.all([
        refreshRuns(),
        selectedRunId ? refreshSelectedRun(selectedRunId) : undefined,
      ]);
      if (current) timer = window.setTimeout(poll, 350);
    };
    let timer = window.setTimeout(poll, 350);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [hasRunningRun, selectedRunId]);

  const startRun = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const run = await createRun(form);
      // 新建结果已接受，旧列表请求不能随后抹掉刚创建的 run。
      ++runsRequestRef.current;
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setSelectedRunId(run.id);
    } catch (submitError) {
      setError(toErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const refreshRuns = async () => {
    const request = ++runsRequestRef.current;
    const detailVersion = runsDetailVersionRef.current;
    try {
      const nextRuns = await fetchRuns();
      if (request !== runsRequestRef.current) return;
      setRuns((items) => {
        // 同批详情可能先完成；仅保留本次list开始后已接受的行，其他行照常刷新，避免整批失效导致饥饿。
        const accepted = new Map(items.map((item) => [item.id, item]));
        return nextRuns.map((item) =>
          (runDetailVersionsRef.current.get(item.id) ?? 0) > detailVersion
            ? (accepted.get(item.id) ?? item)
            : item,
        );
      });
      // 默认选择属于首次接受的列表；手动刷新可先于初始请求完成，但不能抢已有用户选择。
      setSelectedRunId((selected) => selected ?? nextRuns[0]?.id ?? null);
    } catch (loadError) {
      if (request === runsRequestRef.current) setError(toErrorMessage(loadError));
    }
  };

  const refreshSelectedRun = async (runId: string) => {
    if (selectedRunIdRef.current !== runId) return;
    const request = ++selectedRequestRef.current;
    const current = () =>
      selectedRunIdRef.current === runId && selectedRequestRef.current === request;
    try {
      const [run, lines] = await Promise.all([
        fetchRun(runId),
        fetchRawLines(runId).catch(() => []),
      ]);
      // HTTP 请求可以乱序；只有当前选择的最新读取才能提交同一份详情投影。
      if (!current()) return;
      setSelectedRun(run);
      setRawLines(lines);
      runDetailVersionsRef.current.set(run.id, ++runsDetailVersionRef.current);
      setRuns((items) => items.map((item) => (item.id === run.id ? run : item)));
    } catch (loadError) {
      if (current()) setError(toErrorMessage(loadError));
    }
  };

  return (
    <main className="appShell">
      <header className="hero">
        <div>
          <p className="eyebrow">SSE frame profiler</p>
          <h1>Stream Animate</h1>
        </div>
        <button className="ghostButton" type="button" onClick={() => void refreshRuns()}>
          刷新
        </button>
      </header>

      {error ? <div className="errorBanner">{error}</div> : null}

      <div className="layout">
        <aside className="sidebar">
          <RunForm
            config={config}
            disabled={submitting}
            form={form}
            onChange={setForm}
            onSubmit={startRun}
          />
          <RunHistory runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
        </aside>

        <section className="mainColumn">
          <RunSummaryPanel run={displayedRun} />
          <FrameCharts run={displayedRun} />
          <Aggregates runs={runs} />
          <RawPanel lines={displayedRawLines} />
        </section>
      </div>
    </main>
  );
}

function RawPanel({ lines }: { lines: string[] }) {
  return (
    <section className="panel rawPanel">
      <div className="panelHeader">
        <div>
          <h2>Raw NDJSON</h2>
          <p>最近 {lines.length} 行</p>
        </div>
      </div>
      <pre>{lines.join("\n") || "暂无原始数据"}</pre>
    </section>
  );
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
