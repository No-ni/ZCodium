import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { kindOf, type DocKind, type Selection } from "#office/contract.ts";
import { getHost } from "#ui/host.ts";
import { clip, useHostContext } from "#ui/shell/state.ts";
import { useAgentPointer } from "#ui/shell/useAgentPointer.ts";
import { describeAt, strings } from "#ui/i18n.ts";
import { InlineShell } from "#ui/shell/inline.tsx";
import { MoreMenu, SwitchMenu } from "#ui/shell/menus.tsx";
import {
  ChangedBanner,
  Drawer,
  EmptyState,
  ErrorState,
  Skeleton,
  type DrawerTab,
} from "#ui/shell/panes.tsx";
import {
  AgentCallout,
  FindBar,
  OffscreenChip,
  PagePill,
  SelectionBar,
  offscreenText,
} from "#ui/shell/parts.tsx";
import { CLOSED_FIND, useFind } from "#ui/shell/useFind.ts";
import { useCaptureView } from "#ui/shell/useCaptureView.ts";
import { useOffscreenTargets } from "#ui/shell/useOffscreenTargets.ts";
import { useShellKeys } from "#ui/shell/useShellKeys.ts";
import { useDocumentSurface, type RevealRequest } from "#ui/shell/useDocumentSurface.ts";
import { useSelectionActions } from "#ui/shell/useSelectionActions.ts";
import { WorkspacePicker } from "#ui/shell/WorkspacePicker.tsx";
import { DocumentBar } from "#ui/shell/DocumentBar.tsx";
import { VIEWERS } from "#ui/viewers/registry.ts";
import type { PageState, SelectionDetail, ViewerHandle, ZoomState } from "#ui/viewers/types.ts";

const host = getHost();
const PAGED: DocKind[] = ["pdf", "docx", "pptx"];
const ZOOMABLE: DocKind[] = ["pdf", "docx"];
const DOCK_WIDTH = 720;
const INLINE_HEIGHT = 380;

function Shell() {
  const context = useHostContext();
  const t = strings(context?.locale ?? navigator.language);
  const dark = context?.theme === "dark";
  const inline = context?.displayMode === "inline";
  const [menu, setMenu] = useState<"switch" | "more" | null>(null);
  const [picker, setPicker] = useState(false);
  const [drawer, setDrawer] = useState<{ open: boolean; tab: DrawerTab }>({
    open: false,
    tab: "pages",
  });
  const [location, setLocation] = useState<string | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [zoom, setZoom] = useState<ZoomState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wide, setWide] = useState(false);
  const appRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewer = useRef<ViewerHandle | null>(null);
  const revealAction = useRef<(request: RevealRequest) => void>(() => undefined);
  const resetAction = useRef<() => void>(() => undefined);
  const surface = useDocumentSurface(
    t,
    () => resetAction.current(),
    (request) => revealAction.current(request),
  );
  const { doc, docRef, pending, failure, ready, path } = surface;
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 2500);
  }, []);
  const selection = useSelectionActions(t, docRef, viewer, showNotice);
  const { picked, barMode, setBarMode, copied, clearSelection, addReference, ask, copy } =
    selection;
  const clearAgent = useRef<() => void>(() => undefined);
  const onOpenFind = useCallback(() => {
    clearAgent.current();
    clearSelection();
    setMenu(null);
  }, [clearSelection]);
  const { find, setFind, openFind, closeFind, queryFind, stepFind } = useFind({
    viewer,
    docRef,
    ready,
    onOpen: onOpenFind,
  });
  const pointer = useAgentPointer(viewer, surface.generation, canvasRef, doc, closeFind);
  const { agent, setAgent, onRevealHit, stepAgent } = pointer;
  const [offscreen, setOffscreen] = useOffscreenTargets(canvasRef, agent);
  clearAgent.current = pointer.reset;
  resetAction.current = () => {
    pointer.reset();
    clearSelection();
    setOffscreen(null);
    setLocation(null);
    setPage(null);
    setZoom(null);
    setFind(CLOSED_FIND);
  };
  revealAction.current = pointer.reveal;
  const onSelect = useCallback(
    (next: Selection | null, detail?: SelectionDetail) => {
      selection.onSelect(next, detail);
      if (next && detail?.user) setAgent((current) => current && { ...current, visible: false });
    },
    [selection.onSelect, setAgent],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  }, [dark, context?.styles?.variables]);
  useEffect(() => {
    if (inline) void host.app.sendSizeChanged({ height: INLINE_HEIGHT }).catch(() => undefined);
  }, [inline]);
  useEffect(() => {
    const app = appRef.current!;
    const observer = new ResizeObserver(() => setWide(app.clientWidth >= DOCK_WIDTH));
    observer.observe(app);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!doc || !ready) return;
    const timer = setTimeout(() => {
      void host.app
        .callServerTool({
          name: "report_view",
          arguments: {
            viewId: host.viewId,
            path: doc.info.path,
            at: location,
            selection: picked?.selection ?? null,
          },
        })
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [doc, ready, location, picked?.selection]);
  useCaptureView(docRef, viewer, surface.viewerReady, surface.generation);
  const kind = doc?.info.kind ?? (pending ? kindOf(pending) : null);
  const docked = wide && !inline;
  const paged = Boolean(kind && PAGED.includes(kind));
  const drawerAvailable = Boolean(
    doc && ready && kind !== "xlsx" && (viewer.current?.thumbnail || doc?.info.outline.length),
  );
  const goToPage = useCallback((n: number) => viewer.current?.goToPage?.(n), []);
  useShellKeys({
    docRef,
    viewer,
    picked,
    addReference,
    openFind,
    closeFind,
    clearSelection,
    paged,
    page,
    goToPage,
    drawer,
    setDrawer,
    docked,
    find,
    agent,
    setAgent,
  });
  const openPath = (target: string) => {
    setMenu(null);
    setPicker(false);
    surface.openPath(target);
  };
  const browse = () => {
    setMenu(null);
    setPicker(true);
  };
  const Viewer = doc ? VIEWERS[doc.info.kind]?.view : null;
  const viewerNode =
    Viewer && doc ? (
      <Viewer
        key={doc.key}
        ref={viewer}
        bytes={doc.bytes}
        info={doc.info}
        blocks={doc.blocks}
        dark={dark}
        glance={inline}
        onLocation={setLocation}
        onSelect={onSelect}
        onRevealHit={onRevealHit}
        onPage={setPage}
        onZoom={setZoom}
        onReady={surface.onReady}
        onError={surface.onError}
      />
    ) : null;
  const showSkeleton = !failure && (Boolean(pending) || Boolean(doc && !ready));
  const nothing = !doc && !pending && !failure;

  if (inline)
    return (
      <InlineShell
        appRef={appRef}
        canvasRef={canvasRef}
        t={t}
        path={path}
        info={doc?.info}
        kind={kind}
        showSkeleton={showSkeleton}
        failure={failure}
        nothing={nothing}
        onExpand={() =>
          void host.app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined)
        }
      >
        {viewerNode}
      </InlineShell>
    );

  return (
    <div ref={appRef} className="app text-ui-base">
      {nothing ? null : find.open ? (
        <FindBar
          t={t}
          query={find.query}
          total={find.total}
          index={find.index}
          onQuery={queryFind}
          onStep={stepFind}
          onClose={closeFind}
        />
      ) : (
        <DocumentBar
          t={t}
          path={path}
          kind={kind}
          menu={menu}
          drawerOpen={drawer.open}
          drawerAvailable={drawerAvailable}
          ready={ready}
          hasDocument={Boolean(doc && !failure)}
          onDrawer={() => setDrawer((state) => ({ ...state, open: !state.open }))}
          onSwitch={() => setMenu((value) => (value === "switch" ? null : "switch"))}
          onFind={openFind}
          onMore={() => setMenu((value) => (value === "more" ? null : "more"))}
        />
      )}
      {surface.changed ? (
        <ChangedBanner
          t={t}
          onReload={() => doc && void surface.load(doc.info.path)}
          onDismiss={surface.dismissChange}
        />
      ) : null}
      {nothing ? (
        <EmptyState t={t} onBrowse={browse} />
      ) : (
        <div className="stage">
          {drawer.open && drawerAvailable && doc ? (
            <>
              {docked ? null : (
                <div
                  className="scrim"
                  onClick={() => setDrawer((state) => ({ ...state, open: false }))}
                />
              )}
              <Drawer
                t={t}
                info={doc.info}
                handle={viewer.current}
                page={paged ? page : null}
                tab={drawer.tab}
                docked={docked}
                onTab={(tab) => setDrawer((state) => ({ ...state, tab }))}
                onPage={(n) => {
                  goToPage(n);
                  if (!docked) setDrawer((state) => ({ ...state, open: false }));
                }}
                onOutline={(at) => {
                  viewer.current?.goTo(at);
                  if (!docked) setDrawer((state) => ({ ...state, open: false }));
                }}
              />
            </>
          ) : null}
          <div ref={canvasRef} className="canvas">
            {viewerNode}
            {showSkeleton ? <Skeleton kind={kind} /> : null}
            {failure ? (
              <ErrorState
                t={t}
                title={failure.title}
                detail={failure.detail}
                onOpenAnother={browse}
              />
            ) : null}
            {doc && ready && !failure && picked?.detail.user ? (
              <SelectionBar
                key={`${picked.selection.at}:${picked.selection.text.length}`}
                t={t}
                frame={canvasRef}
                locate={picked.detail.locate}
                text={picked.detail.text}
                label={describeAt(picked.selection.at, t)}
                quote={clip(picked.selection.text.replace(/\s+/g, " "), 60)}
                short={doc.info.kind === "xlsx"}
                mode={barMode}
                canAsk={Boolean(host.capabilities?.message)}
                copied={copied}
                onAdd={() => void addReference()}
                onAsk={() => setBarMode("ask")}
                onCopy={() => void copy()}
                onCancelAsk={() => setBarMode("bar")}
                onSend={ask}
              />
            ) : null}
            {agent?.visible && agent.targets[agent.index] && !failure ? (
              <AgentCallout
                t={t}
                frame={canvasRef}
                locate={agent.targets[agent.index].locate}
                note={agent.note}
                index={agent.index}
                total={agent.targets.length}
                onNext={() => stepAgent()}
                onClose={() => setAgent({ ...agent, visible: false })}
              />
            ) : null}
            {agent && offscreen ? (
              <OffscreenChip
                text={offscreenText(
                  t,
                  offscreen.indexes.map((i) => agent.targets[i].at),
                )}
                down={offscreen.down}
                raised={paged}
                onClick={() => stepAgent(offscreen.indexes[0])}
              />
            ) : null}
            {doc && ready && !failure && paged && page ? (
              <PagePill
                t={t}
                frame={canvasRef}
                page={page}
                zoom={kind && ZOOMABLE.includes(kind) ? zoom : null}
                onPage={goToPage}
                onZoom={(direction) => viewer.current?.zoom(direction)}
                onFit={() => viewer.current?.fit("width")}
              />
            ) : null}
            {notice ? <div className="chip notice">{notice}</div> : null}
          </div>
        </div>
      )}
      {menu === "switch" ? (
        <SwitchMenu
          t={t}
          recent={surface.recent}
          currentPath={doc?.info.path}
          onOpen={openPath}
          onBrowse={browse}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {menu === "more" && doc ? (
        <MoreMenu
          t={t}
          zoomable={ZOOMABLE.includes(doc.info.kind)}
          zoomMode={zoom?.mode}
          onFit={(mode) => {
            viewer.current?.fit(mode);
            setMenu(null);
          }}
          onFind={openFind}
          onReload={() => {
            setMenu(null);
            void surface.load(doc.info.path);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {picker ? <WorkspacePicker t={t} onOpen={openPath} onClose={() => setPicker(false)} /> : null}
    </div>
  );
}

const root = document.getElementById("root")!;
root.textContent = "";
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
void host.ready();
