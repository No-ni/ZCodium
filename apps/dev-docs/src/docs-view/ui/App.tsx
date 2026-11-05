import { lazy, useState, useMemo, useCallback, Suspense } from "react";
import { type DocsView } from "../contract.js";
import {
  normalizeText,
  conceptById,
  matchesStructure,
  matchesConcept,
} from "../domain/presentation.js";
import { concepts, structures, protocolSurfaces, flows } from "@/data/protocolDocs.js";
import {
  Network,
  Radio,
  Braces,
  Waypoints,
  GitBranch,
  Search,
  Sun,
  Moon,
  GitCompareArrows,
  Hash,
  Boxes,
} from "lucide-react";
import { ViewButton, Metric, SummaryCard } from "./Navigation.js";
import { StdioTrafficView } from "./StdioTrafficView.js";
import { ConceptLinks, ConceptPanel, ProtocolPanel } from "./ConceptPanels.js";
import { StructureSection } from "./StructureSection.js";

export const CapabilityMapView = lazy(() => import("@/capability-map/CapabilityMapView.js"));

export const FeatureBoundaryGraphView = lazy(
  () => import("@/feature-boundary-graph/FeatureBoundaryGraphView.js"),
);

export function getInitialDocsView(): DocsView {
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "capabilities" || view === "boundary" || view === "protocol" || view === "stdio"
    ? view
    : "stdio";
}

export function App() {
  const [activeView, setActiveView] = useState<DocsView>(getInitialDocsView);
  const [query, setQuery] = useState("");
  const [activeConceptId, setActiveConceptId] = useState("inputId");
  const [isDark, setIsDark] = useState(false);
  const normalizedQuery = normalizeText(query);
  const activeConcept = conceptById.get(activeConceptId) ?? concepts[0];

  const filteredStructures = useMemo(
    () => structures.filter((structure) => matchesStructure(structure, normalizedQuery)),
    [normalizedQuery],
  );

  const filteredConcepts = useMemo(
    () => concepts.filter((concept) => matchesConcept(concept, normalizedQuery)),
    [normalizedQuery],
  );

  const selectView = useCallback((view: DocsView) => {
    setActiveView(view);
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    window.history.replaceState(null, "", url);
  }, []);

  const viewDescription =
    activeView === "capabilities"
      ? "产品能力群、维护边界与跨域语义关系"
      : activeView === "boundary"
        ? "feature-boundary-planner YAML 的节点、关系与边界"
        : activeView === "protocol"
          ? "trace / input / session 数据结构迁移与协议字段说明"
          : "Agent stdio 实时抓包与协议帧检查";

  return (
    <div className={isDark ? "dark min-h-dvh" : "min-h-dvh"}>
      <div className="min-h-dvh bg-background text-foreground">
        <header className="sticky top-0 z-20 border-b border-border bg-header/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-card-border bg-card">
                <Network className="size-4 text-brand" />
              </div>
              <div className="min-w-0">
                <h1 className="text-ui-lg font-medium">ZCode Developer Docs</h1>
                <p className="text-ui-sm text-foreground-subtle">{viewDescription}</p>
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center">
              <nav className="grid grid-cols-4 rounded-lg border border-border bg-surface p-0.5">
                <ViewButton
                  active={activeView === "stdio"}
                  icon={<Radio className="size-4" />}
                  label="stdio 抓包"
                  mobileLabel="stdio"
                  onClick={() => selectView("stdio")}
                />
                <ViewButton
                  active={activeView === "protocol"}
                  icon={<Braces className="size-4" />}
                  label="协议字段"
                  mobileLabel="协议"
                  onClick={() => selectView("protocol")}
                />
                <ViewButton
                  active={activeView === "capabilities"}
                  icon={<Waypoints className="size-4" />}
                  label="能力地图"
                  mobileLabel="能力"
                  onClick={() => selectView("capabilities")}
                />
                <ViewButton
                  active={activeView === "boundary"}
                  icon={<GitBranch className="size-4" />}
                  label="Feature Boundary"
                  mobileLabel="边界"
                  onClick={() => selectView("boundary")}
                />
              </nav>
              {activeView === "protocol" ? (
                <label className="relative min-w-0 flex-1 md:w-80 md:flex-none">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtlest" />
                  <input
                    className="h-8 w-full rounded-lg border border-input-border bg-input pl-8 pr-3 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused focus:bg-input-focused"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索字段、结构、概念"
                  />
                </label>
              ) : null}
              <button
                className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-surface text-foreground hover:bg-surface-hover"
                type="button"
                onClick={() => setIsDark((value) => !value)}
                aria-label={isDark ? "切换浅色主题" : "切换深色主题"}
                title={isDark ? "切换浅色主题" : "切换深色主题"}
              >
                {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </button>
            </div>
          </div>
        </header>

        {activeView === "stdio" ? (
          <StdioTrafficView />
        ) : activeView === "boundary" ? (
          <Suspense
            fallback={
              <main className="grid min-h-[680px] place-items-center p-4 text-ui-base text-foreground-subtle">
                正在加载 Feature Boundary 图谱…
              </main>
            }
          >
            <FeatureBoundaryGraphView />
          </Suspense>
        ) : activeView === "capabilities" ? (
          <Suspense
            fallback={
              <main className="grid min-h-[680px] place-items-center p-4 text-ui-base text-foreground-subtle">
                正在加载能力地图…
              </main>
            }
          >
            <CapabilityMapView />
          </Suspense>
        ) : (
          <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[240px_minmax(0,1fr)_300px]">
            <aside className="hidden lg:block">
              <div className="sticky top-20 rounded-lg border border-card-border bg-card p-2">
                <div className="px-2 py-1 text-ui-sm font-medium text-foreground-subtle">
                  结构目录
                </div>
                <nav className="mt-1 flex flex-col gap-1">
                  {structures.map((structure) => (
                    <a
                      className="rounded-md px-2 py-1.5 text-ui-sm text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
                      href={`#${structure.id}`}
                      key={structure.id}
                    >
                      {structure.title}
                    </a>
                  ))}
                </nav>
              </div>
            </aside>

            <div className="min-w-0 space-y-4">
              <section className="rounded-lg border border-card-border bg-card p-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="mb-2 flex items-center gap-2 text-ui-sm font-medium text-brand">
                      <GitCompareArrows className="size-4" />
                      数据结构迁移
                    </div>
                    <h2 className="text-ui-lg font-medium">
                      从 `traceId` 混用到 `traceId + inputId` 双轴模型
                    </h2>
                    <p className="mt-2 max-w-3xl text-ui-base leading-6 text-foreground-subtle">
                      这次变更把“观测链路”和“用户输入归属”拆开：`traceId`
                      保持日志与协议事件追踪，`inputId` 负责每次发送、排队、stop
                      和终态收口。`sessionId` 仍是 agent server 生成的会话主键。
                    </p>
                  </div>
                  <div className="grid min-w-56 gap-2 rounded-lg border border-border bg-surface p-3 text-ui-sm">
                    <Metric label="结构" value={String(structures.length)} />
                    <Metric label="概念" value={String(concepts.length)} />
                    <Metric label="协议面" value={String(protocolSurfaces.length)} />
                  </div>
                </div>
              </section>

              <section className="grid gap-3 md:grid-cols-3">
                <SummaryCard
                  icon={<Hash className="size-4" />}
                  title="sessionId"
                  body="会话主键，server 生成。UI/task 进入 ZCode Protocol 前必须拿到它。"
                  conceptId="sessionId"
                  onSelect={setActiveConceptId}
                />
                <SummaryCard
                  icon={<Network className="size-4" />}
                  title="traceId"
                  body="观测链路，UUID 格式，不再用作每次 prompt 的 run id。"
                  conceptId="traceId"
                  onSelect={setActiveConceptId}
                />
                <SummaryCard
                  icon={<Boxes className="size-4" />}
                  title="inputId"
                  body="每次用户输入的归属，贯穿 send、turn event、stream event 和 UI 收口。"
                  conceptId="inputId"
                  onSelect={setActiveConceptId}
                />
              </section>

              <section className="rounded-lg border border-card-border bg-card p-4" id="flow">
                <div className="mb-3 flex items-center gap-2">
                  <Braces className="size-4 text-brand" />
                  <h2 className="text-ui-base font-medium">发送链路</h2>
                </div>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {flows.map((step, index) => (
                    <div className="rounded-lg border border-border bg-surface p-3" key={step.id}>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="font-mono text-ui-sm text-foreground-subtle">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="rounded-full border border-border px-2 py-0.5 text-ui-sm text-foreground-subtle">
                          {step.actor}
                        </span>
                      </div>
                      <h3 className="text-ui-base font-medium">{step.title}</h3>
                      <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">
                        {step.detail}
                      </p>
                      <ConceptLinks
                        ids={step.conceptIds}
                        activeId={activeConceptId}
                        onSelect={setActiveConceptId}
                      />
                    </div>
                  ))}
                </div>
              </section>

              <section className="space-y-4">
                {filteredStructures.map((structure) => (
                  <StructureSection
                    activeConceptId={activeConceptId}
                    key={structure.id}
                    onSelectConcept={setActiveConceptId}
                    structure={structure}
                  />
                ))}
                {filteredStructures.length === 0 ? (
                  <div className="rounded-lg border border-card-border bg-card p-4 text-ui-base text-foreground-subtle">
                    没有匹配的数据结构。
                  </div>
                ) : null}
              </section>
            </div>

            <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
              <ConceptPanel
                activeConcept={activeConcept}
                activeConceptId={activeConceptId}
                filteredConcepts={filteredConcepts}
                onSelect={setActiveConceptId}
              />
              <ProtocolPanel activeConceptId={activeConceptId} onSelect={setActiveConceptId} />
            </aside>
          </main>
        )}
      </div>
    </div>
  );
}
