import { ViewTabs, ProjectSelect, TraceSelect, SourceBar, ExecutionGanttPanel, TimelinePanel, ContextPanel, CachePanel, GapsPanel } from "./presentation/index.js";
import type { DebugView, ObservationEventState } from "./presentation/contract.js";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";



import "vis-timeline/styles/vis-timeline-graph2d.min.css";
import type { ObservationChangeEvent, ObservationHelloEvent, ObservationSourceErrorEvent, ProjectSummary, SourceStatus, TraceDetailResponse, TraceListResponse, TraceSummary } from "./shared";


interface SourceInputs {
  projectId: string;
  logDir: string;
  eventPath: string;
  dbPath: string;
  sessionId: string;
}

const emptyInputs: SourceInputs = {
  projectId: "",
  logDir: "",
  eventPath: "",
  dbPath: "",
  sessionId: "",
};

const lastProjectStorageKey = "zcode-debug:last-project-id";

export function App() {
  const [inputs, setInputs] = useState<SourceInputs>(emptyInputs);
  const [traceId, setTraceId] = useState("");
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [detail, setDetail] = useState<TraceDetailResponse | null>(null);
  const [view, setView] = useState<DebugView>(() => viewFromHash(window.location.hash));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => buildQuery(inputs), [inputs]);
  const spans = detail?.spans ?? [];
  const setDebugView = useCallback((nextView: DebugView) => {
    setView(nextView);
    window.history.replaceState(null, "", `#${nextView}`);
  }, []);
  const selectTrace = useCallback((nextTraceId: string) => {
    setTraceId(nextTraceId);
  }, []);

  const loadTraces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchJson<TraceListResponse>(`/api/traces${query}`);
      setTraces(response.traces);
      setProjects(response.projects);
      setSources(response.sources);

      if (!inputs.projectId && response.projects.length > 0) {
        const lastProjectId = window.localStorage.getItem(lastProjectStorageKey);
        const nextProjectId =
          response.projects.find((project) => project.projectId === lastProjectId)?.projectId ??
          response.projects[0]?.projectId;
        if (nextProjectId) {
          setInputs((current) => ({ ...current, projectId: nextProjectId }));
        }
      }

      const hasCurrentTrace = response.traces.some((trace) => trace.traceId === traceId);
      if (!hasCurrentTrace) {
        setTraceId(response.traces[0]?.traceId ?? "");
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setLoading(false);
    }
  }, [inputs.projectId, query, traceId]);

  const loadTraceDetail = useCallback(async () => {
    if (!traceId.trim()) {
      setDetail(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const encoded = encodeURIComponent(traceId.trim());
      const response = await fetchJson<TraceDetailResponse>(`/api/traces/${encoded}${query}`);
      setDetail(response);
      setSources(response.sources);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setLoading(false);
    }
  }, [query, traceId]);

  const refreshObservations = useCallback(() => {
    void loadTraces();
    void loadTraceDetail();
  }, [loadTraceDetail, loadTraces]);
  const observationEvents = useObservationEvents(query, refreshObservations);

  useEffect(() => {
    void loadTraces();
  }, [loadTraces]);

  useEffect(() => {
    void loadTraceDetail();
  }, [loadTraceDetail]);

  useEffect(() => {
    if (inputs.projectId) {
      window.localStorage.setItem(lastProjectStorageKey, inputs.projectId);
    }
  }, [inputs.projectId]);

  useEffect(() => {
    const syncViewFromHash = () => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", syncViewFromHash);
    return () => window.removeEventListener("hashchange", syncViewFromHash);
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>ZCode 调试台</h1>
          <p>Trace、甘特执行、网络抓包</p>
        </div>
        <div className="topbar-actions">
          <ViewTabs activeView={view} onChange={setDebugView} />
          <button
            className="icon-button"
            type="button"
            onClick={() => void loadTraces()}
            title="刷新"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <section className="control-strip" aria-label="调试控制">
        <ProjectSelect
          projects={projects}
          value={inputs.projectId}
          onChange={(value) => {
            setInputs((current) => ({ ...current, projectId: value }));
            setTraceId("");
          }}
        />
        <TraceSelect traces={traces} value={traceId} onChange={selectTrace} />
      </section>

      {error ? (
        <div className="notice error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <SourceBar sources={sources} loading={loading} live={observationEvents} />

      {view === "trace" ? (
        <div className="workspace-grid">
          <TimelinePanel items={detail?.timeline ?? []} />
          <div className="side-stack">
            <ContextPanel
              snapshots={detail?.contextSnapshots ?? []}
              usageSnapshots={detail?.contextUsageSnapshots ?? []}
            />
            <CachePanel reports={detail?.cacheReports ?? []} />
            <GapsPanel requests={detail?.developerRequests ?? []} />
          </div>
        </div>
      ) : null}

      {view === "gantt" ? (
        <div className="gantt-page">
          <ExecutionGanttPanel spans={spans} traceId={traceId} />
        </div>
      ) : null}
    </main>
  );
}

function useObservationEvents(query: string, onChange: () => void): ObservationEventState {
  const onChangeRef = useRef(onChange);
  const [state, setState] = useState<ObservationEventState>({
    connected: false,
    error: null,
    watchedPathCount: 0,
  });

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let closed = false;
    let refreshTimer: number | undefined;
    const events = new EventSource(`/api/observations/events${query}`);

    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (!closed) onChangeRef.current();
      }, 180);
    };

    events.addEventListener("hello", (event) => {
      const parsed = parseMessageEvent<ObservationHelloEvent>(event);
      if (!parsed || closed) return;
      setState({
        connected: true,
        error: null,
        watchedPathCount: parsed.sources.length,
      });
    });
    events.addEventListener("change", (event) => {
      const parsed = parseMessageEvent<ObservationChangeEvent>(event);
      if (!parsed || closed) return;
      setState({
        connected: true,
        error: null,
        lastChangeAt: parsed.changedAt,
        watchedPathCount: parsed.sources.length,
      });
      scheduleRefresh();
    });
    events.addEventListener("source-error", (event) => {
      const parsed = parseMessageEvent<ObservationSourceErrorEvent>(event);
      if (!parsed || closed) return;
      setState((current) => ({
        ...current,
        connected: true,
        error: parsed.message,
      }));
    });
    events.addEventListener("open", () => {
      if (!closed) {
        setState((current) => ({ ...current, connected: true, error: null }));
      }
    });
    events.addEventListener("error", () => {
      if (!closed) {
        setState((current) => ({
          ...current,
          connected: false,
          error: "观测事件流已断开，正在等待浏览器重连。",
        }));
      }
    });

    return () => {
      closed = true;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      events.close();
    };
  }, [query]);

  return state;
}

function buildQuery(inputs: SourceInputs): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(inputs)) {
    if (value.trim()) params.set(key, value.trim());
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function parseMessageEvent<T>(event: Event): T | null {
  const data = (event as MessageEvent<string>).data;
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

function viewFromHash(hash: string): DebugView {
  const normalized = hash.replace(/^#/, "");
  if (normalized === "gantt") return normalized;
  return "gantt";
}
