import { useEffect, useRef, useState } from "react";
import {
  type DocumentInfo,
  type DocxBlockKey,
  type FileHandle,
  type ViewerSnapshot,
  type ShowTarget,
} from "#office/contract.ts";
import { readFileBytes } from "#ui/assets.ts";
import { getHost } from "#ui/host.ts";
import { call } from "#ui/rpc.ts";
import type { Strings } from "#ui/i18n.ts";
import { VIEWERS } from "#ui/viewers/registry.ts";
import {
  describeFailure,
  readRecent,
  writeRecent,
  type Failure,
  type LoadedDoc,
} from "#ui/shell/state.ts";

export interface RevealRequest {
  targets: ShowTarget[];
  note: string | null;
}

/** 单个面板的加载代次、渲染就绪与宿主快照；文件和已接受文档事实仍由 DocumentOwner 持有。 */
export function useDocumentSurface(
  t: Strings,
  onReset: () => void,
  onReveal: (request: RevealRequest) => void,
) {
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [ready, setReady] = useState(false);
  const [changed, setChanged] = useState<string | null>(null);
  const [recent, setRecent] = useState(readRecent);
  const docRef = useRef(doc);
  docRef.current = doc;
  const viewerReady = useRef(false);
  const generation = useRef(0);
  const loadingPath = useRef<string | null>(null);
  const pendingReveal = useRef<RevealRequest | null>(null);
  const revealSeq = useRef(0);
  const dismissedRevision = useRef<string | null>(null);
  const actions = useRef({ t, onReset, onReveal });
  actions.current = { t, onReset, onReveal };
  const alive = useRef(true);

  async function load(target: string, reveal?: RevealRequest | null) {
    const mine = ++generation.current;
    viewerReady.current = false;
    setReady(false);
    setDoc(null);
    if (reveal) pendingReveal.current = reveal;
    else if (loadingPath.current !== target) pendingReveal.current = null;
    loadingPath.current = target;
    setPending(target);
    setFailure(null);
    actions.current.onReset();
    try {
      const loaded = await call<{ info: DocumentInfo; file: FileHandle; blocks?: DocxBlockKey[] }>(
        "load_document",
        { path: target },
      );
      if (mine !== generation.current || !alive.current) return;
      const [bytes] = await Promise.all([
        readFileBytes(loaded.file),
        VIEWERS[loaded.info.kind]?.prepare?.(),
      ]);
      if (mine !== generation.current || !alive.current) return;
      dismissedRevision.current = null;
      setChanged(null);
      setDoc({ info: loaded.info, bytes, blocks: loaded.blocks, key: mine });
      getHost().saveDocument(loaded.info.path);
      setRecent((items) => {
        const next = [
          { path: loaded.info.path, kind: loaded.info.kind },
          ...items.filter((item) => item.path !== loaded.info.path),
        ].slice(0, 5);
        writeRecent(next);
        return next;
      });
    } catch (error) {
      if (mine !== generation.current || !alive.current) return;
      setDoc(null);
      pendingReveal.current = null;
      setFailure(describeFailure(actions.current.t, error, target));
    } finally {
      if (mine === generation.current && alive.current) {
        setPending(null);
        loadingPath.current = null;
      }
    }
  }

  function applySnapshot(snapshot: ViewerSnapshot | undefined) {
    if (!snapshot?.document) return;
    // 已收到更晚的 reveal 不再接受旧结果，避免重放把面板退回旧文档。
    if (snapshot.reveal && snapshot.reveal.seq <= revealSeq.current) return;
    const reveal = snapshot.reveal;
    if (reveal) revealSeq.current = reveal.seq;
    const pointer = reveal ? { targets: reveal.targets, note: reveal.note ?? null } : null;
    const current = docRef.current?.info;
    if (
      !current ||
      current.path !== snapshot.document.path ||
      current.revision !== snapshot.document.revision
    ) {
      void load(snapshot.document.path, pointer);
    } else if (pointer) {
      if (viewerReady.current) actions.current.onReveal(pointer);
      else pendingReveal.current = pointer;
    }
  }
  const snapshotAction = useRef(applySnapshot);
  snapshotAction.current = applySnapshot;
  const loadAction = useRef(load);
  loadAction.current = load;

  useEffect(() => {
    let active = true;
    alive.current = true;
    const host = getHost();
    const consume = (results: ReturnType<typeof host.takeResults>) => {
      const accepted = results.filter((result) => !result.isError);
      const last = accepted.at(-1);
      if (!last) return false;
      if ((last._meta as Record<string, unknown> | undefined)?.["zcode/truncated"])
        void call<ViewerSnapshot>("get_viewer").then(
          (value) => active && snapshotAction.current(value),
          () => undefined,
        );
      else snapshotAction.current(last.structuredContent as ViewerSnapshot | undefined);
      return true;
    };
    const drain = () => consume(host.takeResults());
    window.addEventListener("office:toolresult", drain);
    void host.ready().then(
      () => {
        if (!active) return;
        setRecent(readRecent());
        // live 初始结果优先于恢复记录；StrictMode 已清理的 effect 不得排空消息。
        if (!consume(host.takeResults())) {
          const path = host.readDocument();
          if (path) void loadAction.current(path);
        }
      },
      () => active && setFailure(describeFailure(actions.current.t, null, null)),
    );
    return () => {
      active = false;
      alive.current = false;
      window.removeEventListener("office:toolresult", drain);
    };
  }, []);

  useEffect(() => {
    if (!doc) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void call<{ revision: string }>("check_document", { path: doc.info.path }).then(
        ({ revision }) => {
          if (docRef.current !== doc) return;
          if (revision !== doc.info.revision && revision !== dismissedRevision.current)
            setChanged(revision);
        },
        () => undefined,
      );
    }, 4000);
    return () => clearInterval(timer);
  }, [doc]);

  return {
    doc,
    docRef,
    pending,
    failure,
    ready,
    viewerReady,
    generation,
    changed,
    recent,
    path: pending ?? failure?.path ?? doc?.info.path ?? null,
    load,
    openPath(target: string) {
      const requestGeneration = ++generation.current;
      void call<ViewerSnapshot>("open_document", { path: target }).then(
        (snapshot) => {
          if (requestGeneration === generation.current && alive.current)
            snapshotAction.current(snapshot);
        },
        (error) => {
          if (requestGeneration !== generation.current || !alive.current) return;
          setDoc(null);
          viewerReady.current = false;
          setReady(false);
          setFailure(describeFailure(actions.current.t, error, target));
          actions.current.onReset();
        },
      );
    },
    onReady() {
      if (!docRef.current || pending) return;
      viewerReady.current = true;
      setReady(true);
      const reveal = pendingReveal.current;
      pendingReveal.current = null;
      if (reveal) actions.current.onReveal(reveal);
    },
    onError(error: Error) {
      viewerReady.current = false;
      setReady(false);
      setFailure(describeFailure(actions.current.t, error, docRef.current?.info.path ?? null));
    },
    dismissChange() {
      dismissedRevision.current = changed;
      setChanged(null);
    },
  };
}
