import type { UseConversationTimelineFindOptions } from "@/v4/conversationTimelineFindTypes.js";
export type { UseConversationTimelineFindOptions } from "@/v4/conversationTimelineFindTypes.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyConversationFindHighlights,
  applySearchResultHighlight,
  clearConversationFindHighlights,
  clearSearchResultHighlight,
  getMountedConversationFindRow,
  scrollConversationFindRangeIntoView,
} from "@/v4/conversationFindHighlightDom.js";
import {
  createConversationFindIndexBuilder,
  findConversationMatchIndexByKey,
  getConversationFindMatchKey,
  resolveConversationFindActiveIndex,
  resolveSearchResultHighlightMatch,
  type ConversationFindMatch,
  type ConversationFindMatchKey,
} from "@/v4/conversationFindIndex.js";
import {
  appendUnitFindMatches,
  getFindMatch,
  sourceTextContainsSnippet,
  type UnitFindCache,
} from "@/v4/conversationTimelineFindCache.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";

const FIND_AUTO_LOAD_ROW_LIMIT = 1200;
const SEARCH_RESULT_HIGHLIGHT_DURATION_MS = 3000;

export function useConversationTimelineFind({
  rootRef,
  renderUnits,
  rows,
  mountedRowsKey,
  canLoadOlder,
  loadingOlder,
  onLoadOlder,
  sessionPhase,
  conversationFindQuery,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  scrollToUnit,
  isMountedLayoutMeasured,
}: UseConversationTimelineFindOptions) {
  const buildFindIndex = useMemo(() => createConversationFindIndexBuilder(), []);
  // 未查找时的固定空索引：依赖它的 effect 不会随每个流式帧重跑。
  const emptyFindIndex = useMemo(() => buildFindIndex([], ""), [buildFindIndex]);
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const findStable = sessionPhase !== "running" && sessionPhase !== "prewarming";
  const normalizedFindQuery = conversationFindQuery.trim().toLocaleLowerCase();
  // 历史段与尾段各自只保留当前段的 unit；两段之间迁移的 unit 由对方的表兜底命中。
  const historyFindCacheRef = useRef<UnitFindCache>(new Map());
  const tailFindCacheRef = useRef<UnitFindCache>(new Map());
  // Bug 根因：原先按全部 render unit 构建，即使未查找也要逐轮拼缓存键，流式帧成本随历史线性增长。
  // 历史段命中按 history 引用缓存，每帧只为尾段重建；未查找时直接返回固定空索引。
  const historyFindIndex = useMemo(() => {
    const matches: ConversationFindMatch[] = [];
    if (!normalizedFindQuery) {
      // 查找关闭时不再留着上一次查询的 unit 与命中（修改前每次调用都只保留当前窗口的 unit）。
      if (historyFindCacheRef.current.size > 0) historyFindCacheRef.current = new Map();
      return { matches, loadedRowCount: 0 };
    }
    const nextCache: UnitFindCache = new Map();
    const loadedRowCount = appendUnitFindMatches({
      units: renderUnits.history,
      indexOffset: 0,
      matches,
      cacheKeyPrefix: `${normalizedFindQuery}:${codeCommentCardsEnabled}`,
      lookups: [historyFindCacheRef.current, tailFindCacheRef.current],
      nextCache,
      build: (unit) =>
        buildFindIndex([unit], conversationFindQuery, {
          projectAssistantCodeComments: codeCommentCardsEnabled,
        }),
    });
    // 仅保留当前窗口，不让裁剪后的历史命中继续占用缓存。
    historyFindCacheRef.current = nextCache;
    return { matches, loadedRowCount };
  }, [
    buildFindIndex,
    codeCommentCardsEnabled,
    conversationFindQuery,
    normalizedFindQuery,
    renderUnits.history,
  ]);
  const conversationFindIndex = useMemo(() => {
    if (!normalizedFindQuery) {
      if (tailFindCacheRef.current.size > 0) tailFindCacheRef.current = new Map();
      return emptyFindIndex;
    }
    const matches = [...historyFindIndex.matches];
    const nextCache: UnitFindCache = new Map();
    // 尾段通常是正在运行的最后一轮，运行中的 unit 不缓存；尾段里已结束的 unit 与历史段一样复用。
    const tailRowCount = appendUnitFindMatches({
      units: renderUnits.tail,
      indexOffset: renderUnits.history.length,
      matches,
      cacheKeyPrefix: `${normalizedFindQuery}:${codeCommentCardsEnabled}`,
      lookups: [tailFindCacheRef.current, historyFindCacheRef.current],
      nextCache,
      build: (unit) =>
        buildFindIndex([unit], conversationFindQuery, {
          projectAssistantCodeComments: codeCommentCardsEnabled,
        }),
    });
    tailFindCacheRef.current = nextCache;
    return {
      query: normalizedFindQuery,
      matches,
      matchCount: matches.length,
      loadedRowCount: historyFindIndex.loadedRowCount + tailRowCount,
    };
  }, [
    buildFindIndex,
    codeCommentCardsEnabled,
    conversationFindQuery,
    emptyFindIndex,
    historyFindIndex,
    normalizedFindQuery,
    renderUnits,
  ]);
  const searchResultFindIndex = useMemo(
    () =>
      findStable && searchResultHighlightRequest
        ? buildFindIndex(
            [...renderUnits.history, ...renderUnits.tail],
            searchResultHighlightRequest.query,
            { projectAssistantCodeComments: codeCommentCardsEnabled },
          )
        : emptyFindIndex,
    [
      buildFindIndex,
      codeCommentCardsEnabled,
      emptyFindIndex,
      findStable,
      renderUnits,
      searchResultHighlightRequest,
    ],
  );
  const searchResultMatch = useMemo(
    () =>
      searchResultHighlightRequest
        ? resolveSearchResultHighlightMatch(searchResultFindIndex, searchResultHighlightRequest)
        : null,
    [searchResultFindIndex, searchResultHighlightRequest],
  );
  const searchResultSnippet = searchResultHighlightRequest?.snippet?.trim();
  // resolver 优先返回包含片段的首项，否则才 fallback；检查返回项就能确定是否存在片段。
  // 两个 effect 共用这个派生结果，避免补页与高亮各自按命中数反复规范化同一正文。
  const searchResultSnippetFound = useMemo(
    () =>
      !searchResultSnippet ||
      Boolean(
        searchResultMatch &&
        sourceTextContainsSnippet(searchResultMatch.sourceText, searchResultSnippet),
      ),
    [searchResultMatch, searchResultSnippet],
  );
  const [resolvedFindActiveIndex, setResolvedFindActiveIndex] = useState(-1);
  const findActiveKeyRef = useRef<ConversationFindMatchKey | null>(null);
  const lastFindQueryRef = useRef("");
  const lastExternalActiveIndexRef = useRef(conversationFindActiveIndex);
  const lastFindScrollKeyRef = useRef("");
  const lastFindHighlightScrollKeyRef = useRef("");
  const lastFindAutoLoadAttemptRef = useRef("");
  const lastSearchResultAutoLoadAttemptRef = useRef("");
  const searchResultAppliedRequestRef = useRef<number | null>(null);
  const searchResultScrollRequestRef = useRef<number | null>(null);
  const searchResultCleanupTimerRef = useRef<number | undefined>(undefined);
  const activeFindMatch = getFindMatch(conversationFindIndex.matches, resolvedFindActiveIndex);

  useEffect(() => {
    if (!conversationFindIndex.query) {
      findActiveKeyRef.current = null;
      lastFindQueryRef.current = "";
      lastFindScrollKeyRef.current = "";
      lastFindHighlightScrollKeyRef.current = "";
      setResolvedFindActiveIndex(-1);
      clearConversationFindHighlights();
      onConversationFindMatchStateChange?.({ matchCount: 0, activeIndex: -1 });
      return;
    }

    const queryChanged = lastFindQueryRef.current !== conversationFindIndex.query;
    const externalActiveIndexChanged =
      lastExternalActiveIndexRef.current !== conversationFindActiveIndex;
    let nextActiveIndex = resolveConversationFindActiveIndex(
      conversationFindIndex,
      conversationFindActiveIndex,
    );

    if (!queryChanged && !externalActiveIndexChanged) {
      const rebasedIndex = findConversationMatchIndexByKey(
        conversationFindIndex,
        findActiveKeyRef.current,
      );
      if (rebasedIndex >= 0) {
        nextActiveIndex = rebasedIndex;
      }
    }

    const activeMatch = getFindMatch(conversationFindIndex.matches, nextActiveIndex);
    findActiveKeyRef.current = getConversationFindMatchKey(activeMatch);
    lastFindQueryRef.current = conversationFindIndex.query;
    lastExternalActiveIndexRef.current = nextActiveIndex;
    setResolvedFindActiveIndex(nextActiveIndex);
    onConversationFindMatchStateChange?.({
      matchCount: conversationFindIndex.matchCount,
      activeIndex: nextActiveIndex,
    });
  }, [conversationFindActiveIndex, conversationFindIndex, onConversationFindMatchStateChange]);

  useEffect(() => {
    if (
      !findStable ||
      !conversationFindIndex.query ||
      !canLoadOlder ||
      loadingOlder ||
      rows.length >= FIND_AUTO_LOAD_ROW_LIMIT
    ) {
      return;
    }
    const attemptKey = `${conversationFindIndex.query}:${rows[0]?.rowId ?? "none"}:${rows.length}`;
    if (lastFindAutoLoadAttemptRef.current === attemptKey) {
      return;
    }
    lastFindAutoLoadAttemptRef.current = attemptKey;
    void onLoadOlder?.();
  }, [canLoadOlder, conversationFindIndex.query, findStable, loadingOlder, onLoadOlder, rows]);

  useEffect(() => {
    if (!conversationFindIndex.query || !activeFindMatch) {
      return;
    }
    // Bug 根因：单命中回环只更新 DOM 高亮请求，离开虚拟窗口后已没有 Range 可滚动。
    // 显式导航同样驱动虚拟窗口定位；被动命中回报仍按相同请求去重。
    const scrollKey = `${conversationFindNavigationRequestId}:${conversationFindIndex.query}:${activeFindMatch.rowId}:${activeFindMatch.rowMatchIndex}:${activeFindMatch.unitIndex}`;
    if (lastFindScrollKeyRef.current === scrollKey) {
      return;
    }
    lastFindScrollKeyRef.current = scrollKey;
    scrollToUnit(activeFindMatch.unitIndex);
  }, [
    activeFindMatch,
    conversationFindIndex.query,
    conversationFindNavigationRequestId,
    scrollToUnit,
  ]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !conversationFindIndex.query) {
      clearConversationFindHighlights();
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const activeRange = applyConversationFindHighlights({
        root,
        query: conversationFindQuery,
        matches: conversationFindIndex.matches,
        activeMatch: activeFindMatch,
      });
      const highlightScrollKey = `${conversationFindNavigationRequestId}:${conversationFindIndex.query}:${activeFindMatch?.rowId ?? "none"}:${activeFindMatch?.rowMatchIndex ?? -1}:${activeFindMatch?.unitIndex ?? -1}`;
      // 挂载不等于布局已入账；尺寸仍是估计值时居中会使用即将失效的坐标。
      // 用本批实际布局确认交接，尺寸提交由 mountedRowsKey 唤醒，不依赖固定延时。
      if (
        lastFindHighlightScrollKeyRef.current !== highlightScrollKey &&
        isMountedLayoutMeasured()
      ) {
        // 宽度改变时暂停测高补偿，目标可能被前方行增高挤出虚拟窗口。
        // 仅未完成的请求随测量提交重新定位；到位后用户滚走不能再次拉回。
        // 源 Markdown 标记、链接地址可能没有 DOM Range；已挂载的目标必须结束请求，
        // 否则用户滚走触发窗口更新后会被反复拉回。只有目标行未挂载才继续粗定位。
        if (
          !activeRange &&
          activeFindMatch &&
          !getMountedConversationFindRow(root, activeFindMatch.rowId)
        ) {
          scrollToUnit(activeFindMatch.unitIndex);
          return;
        }
        lastFindHighlightScrollKeyRef.current = highlightScrollKey;
        if (activeRange) scrollConversationFindRangeIntoView(activeRange);
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    activeFindMatch,
    conversationFindIndex,
    conversationFindQuery,
    conversationFindNavigationRequestId,
    mountedRowsKey,
    isMountedLayoutMeasured,
    scrollToUnit,
    rootRef,
  ]);

  useEffect(() => {
    const request = searchResultHighlightRequest;
    if (
      !request ||
      !findStable ||
      !canLoadOlder ||
      loadingOlder ||
      rows.length >= FIND_AUTO_LOAD_ROW_LIMIT
    ) {
      return;
    }
    const snippet = request.snippet?.trim();
    const shouldLoadMore = snippet
      ? !searchResultSnippetFound
      : searchResultFindIndex.matchCount === 0;
    if (shouldLoadMore) {
      const attemptKey = `${request.requestId}:${rows[0]?.rowId ?? "none"}:${rows.length}`;
      if (lastSearchResultAutoLoadAttemptRef.current === attemptKey) {
        return;
      }
      lastSearchResultAutoLoadAttemptRef.current = attemptKey;
      void onLoadOlder?.();
    }
  }, [
    canLoadOlder,
    findStable,
    loadingOlder,
    onLoadOlder,
    rows,
    searchResultFindIndex,
    searchResultHighlightRequest,
    searchResultSnippetFound,
  ]);

  useEffect(() => {
    const request = searchResultHighlightRequest;
    if (!request || !findStable) {
      clearSearchResultHighlight();
      searchResultAppliedRequestRef.current = null;
      searchResultScrollRequestRef.current = null;
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
        searchResultCleanupTimerRef.current = undefined;
      }
      return;
    }

    const match = searchResultMatch;
    const snippet = request.snippet?.trim();
    const snippetFound = searchResultSnippetFound;
    const canStillLoad = canLoadOlder && rows.length < FIND_AUTO_LOAD_ROW_LIMIT && !loadingOlder;
    if (snippet && !snippetFound && (canStillLoad || loadingOlder)) {
      return;
    }
    if (!match) {
      if (!canStillLoad) {
        onSearchResultHighlightDone?.(request.requestId);
      }
      return;
    }

    if (searchResultScrollRequestRef.current !== request.requestId) {
      searchResultScrollRequestRef.current = request.requestId;
      scrollToUnit(match.unitIndex);
    }

    if (searchResultAppliedRequestRef.current === request.requestId) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      const range = applySearchResultHighlight({
        root,
        query: request.query,
        match,
      });
      if (!isMountedLayoutMeasured()) {
        return;
      }
      // 历史搜索结果同样区分未挂载和不可高亮，避免无 Range 请求永久抢占滚动。
      if (!range && !getMountedConversationFindRow(root, match.rowId)) {
        scrollToUnit(match.unitIndex);
        return;
      }
      searchResultAppliedRequestRef.current = request.requestId;
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
        searchResultCleanupTimerRef.current = undefined;
      }
      if (!range) {
        clearSearchResultHighlight();
        onSearchResultHighlightDone?.(request.requestId);
        return;
      }
      scrollConversationFindRangeIntoView(range);
      searchResultCleanupTimerRef.current = window.setTimeout(() => {
        clearSearchResultHighlight();
        onSearchResultHighlightDone?.(request.requestId);
        searchResultCleanupTimerRef.current = undefined;
      }, SEARCH_RESULT_HIGHLIGHT_DURATION_MS);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    canLoadOlder,
    findStable,
    loadingOlder,
    mountedRowsKey,
    isMountedLayoutMeasured,
    onSearchResultHighlightDone,
    rootRef,
    rows,
    scrollToUnit,
    searchResultHighlightRequest,
    searchResultMatch,
    searchResultSnippetFound,
  ]);

  useEffect(() => {
    return () => {
      clearConversationFindHighlights();
      clearSearchResultHighlight();
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
      }
    };
  }, []);
}
