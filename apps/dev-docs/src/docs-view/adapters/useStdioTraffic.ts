import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import {
  sortTrafficFramesByNewest,
  mapRealTrafficFrames,
  formatIsoTrafficTimestamp,
  formatTrafficTimestamp,
} from "../domain/trafficFrames.js";
import { stdioTrafficFrames, type StdioTrafficFrame } from "@/data/protocolDocs.js";
import {
  type DirectionFilter,
  type TrafficSourceMode,
  type RealTrafficState,
  type StdioTrafficApiResponse,
} from "../contract.js";
import { normalizeText } from "../domain/presentation.js";
import { createLiveStdioTrafficFrame } from "../domain/mockTraffic.js";

export function useStdioTraffic() {
  const initialFrames = useMemo(() => sortTrafficFramesByNewest(stdioTrafficFrames), []);
  const [trafficFrames, setTrafficFrames] = useState<StdioTrafficFrame[]>([]);
  const [trafficQuery, setTrafficQuery] = useState("");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [trafficSourceMode, setTrafficSourceMode] = useState<TrafficSourceMode>("real");
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [selectedFrameId, setSelectedFrameId] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState("--:--:--.---");
  const [realTraffic, setRealTraffic] = useState<RealTrafficState>({
    status: "loading",
    logDir: "~/.zcodium/v2/dev/stdio-traffic",
    records: [],
  });
  const liveSequenceRef = useRef(0);
  const trafficRequestRef = useRef(0);
  const trafficSourceRef = useRef<TrafficSourceMode | "inactive">("real");
  const normalizedTrafficQuery = normalizeText(trafficQuery);
  const latestFrame = trafficFrames[0];
  const isMockReplayEnabled = trafficSourceMode === "mock";

  const fetchRealTraffic = useCallback(async () => {
    if (trafficSourceRef.current !== "real") return;
    const request = ++trafficRequestRef.current;
    // 轮询与Reload可重叠；只有当前真实模式的最新请求能提交，旧成功/失败不能覆盖新记录。
    const isCurrent = () =>
      trafficSourceRef.current === "real" && trafficRequestRef.current === request;
    try {
      const response = await fetch("/api/dev/stdio-traffic?limit=400", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as StdioTrafficApiResponse;
      if (!isCurrent()) return;
      setRealTraffic({
        status: data.status,
        logDir: data.logDir,
        records: Array.isArray(data.records) ? data.records : [],
        error: data.error,
        filePath: data.filePath,
        updatedAt: data.updatedAt,
        workspaceHash: data.workspaceHash,
      });
    } catch (error) {
      if (!isCurrent()) return;
      setRealTraffic((current) => ({
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        records: [],
      }));
    }
  }, []);

  useEffect(() => {
    if (trafficSourceMode !== "real") {
      return;
    }

    trafficSourceRef.current = "real";
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      await fetchRealTraffic();
      // 慢读结束后再调度，避免固定间隔持续制造重叠并让每一轮响应都过期。
      if (!disposed) timer = window.setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      trafficSourceRef.current = "inactive";
      trafficRequestRef.current += 1;
    };
  }, [fetchRealTraffic, trafficSourceMode]);

  useEffect(() => {
    if (trafficSourceMode !== "real") {
      return;
    }

    const realFrames = sortTrafficFramesByNewest(mapRealTrafficFrames(realTraffic));
    setTrafficFrames(realFrames);
    setLastUpdatedAt(
      realTraffic.updatedAt
        ? formatIsoTrafficTimestamp(realTraffic.updatedAt)
        : (realFrames[0]?.timestamp ?? "--:--:--.---"),
    );
    setSelectedFrameId((currentFrameId) =>
      isFollowingLatest || !realFrames.some((frame) => frame.id === currentFrameId)
        ? (realFrames[0]?.id ?? "")
        : currentFrameId,
    );
  }, [isFollowingLatest, realTraffic, trafficSourceMode]);

  useEffect(() => {
    if (!isMockReplayEnabled) {
      return;
    }

    // mock replay 只用于演示；真实调试默认走 Vite 本地 API 读取 tap proxy 的 NDJSON。
    const timer = window.setInterval(() => {
      liveSequenceRef.current += 1;
      const nextFrame = createLiveStdioTrafficFrame(
        liveSequenceRef.current,
        formatTrafficTimestamp(new Date()),
      );

      setTrafficFrames((currentFrames) =>
        sortTrafficFramesByNewest([nextFrame, ...currentFrames]).slice(0, 48),
      );
      setLastUpdatedAt(nextFrame.timestamp);

      if (isFollowingLatest) {
        setSelectedFrameId(nextFrame.id);
      }
    }, 1800);

    return () => window.clearInterval(timer);
  }, [isFollowingLatest, isMockReplayEnabled]);

  const followLatest = () => {
    setIsFollowingLatest(true);
    setSelectedFrameId(trafficFrames[0]?.id ?? "");
  };

  const startMockReplay = () => {
    // 在React effect清理前即作废真实读取，防止切换模式这一帧仍接收旧回包。
    trafficSourceRef.current = "mock";
    trafficRequestRef.current += 1;
    liveSequenceRef.current = 0;
    setTrafficFrames(initialFrames);
    setLastUpdatedAt(initialFrames[0]?.timestamp ?? "--:--:--.---");
    setIsFollowingLatest(true);
    setTrafficSourceMode("mock");
    setSelectedFrameId(initialFrames[0]?.id ?? "");
  };

  const stopMockReplay = () => {
    liveSequenceRef.current = 0;
    setTrafficSourceMode("real");
  };

  const refreshTrafficSource = () => {
    if (trafficSourceMode === "mock") {
      startMockReplay();
      return;
    }

    void fetchRealTraffic();
  };

  const filteredFrames = useMemo(
    () =>
      sortTrafficFramesByNewest(
        trafficFrames.filter((frame) => {
          const directionMatches = directionFilter === "all" || frame.direction === directionFilter;
          if (!directionMatches) {
            return false;
          }
          if (!normalizedTrafficQuery) {
            return true;
          }
          const haystack = [
            frame.id,
            frame.timestamp,
            frame.direction,
            frame.kind,
            frame.method ?? "",
            frame.messageId ?? "",
            frame.sessionId ?? "",
            frame.inputId ?? "",
            frame.summary,
            frame.raw,
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(normalizedTrafficQuery);
        }),
      ),
    [directionFilter, normalizedTrafficQuery, trafficFrames],
  );

  const selectedFrame =
    filteredFrames.find((frame) => frame.id === selectedFrameId) ??
    trafficFrames.find((frame) => frame.id === selectedFrameId) ??
    filteredFrames[0] ??
    trafficFrames[0];

  const linkedFrame = selectedFrame?.linkedId
    ? trafficFrames.find((frame) => frame.id === selectedFrame.linkedId)
    : undefined;
  const trafficStatusLabel =
    trafficSourceMode === "mock"
      ? "mock replay"
      : realTraffic.status === "ready"
        ? "real tail"
        : realTraffic.status;
  const trafficStatusClassName =
    trafficSourceMode === "mock"
      ? "border-warning/35 bg-warning/12 text-foreground"
      : realTraffic.status === "ready"
        ? "border-success/35 bg-success/12 text-foreground"
        : "border-border bg-surface text-foreground-subtle";
  const sourcePath =
    trafficSourceMode === "mock"
      ? "mock replay"
      : (realTraffic.filePath ?? realTraffic.logDir ?? "~/.zcodium/v2/dev/stdio-traffic");
  const emptyTrafficMessage =
    trafficSourceMode === "mock"
      ? "mock replay 暂无 frame。"
      : realTraffic.status === "missing"
        ? "没有找到 stdio tap 文件。先在开发环境 Help 里打开抓取开关并启动一个 agent。"
        : realTraffic.status === "error"
          ? `读取 stdio tap 失败：${realTraffic.error ?? "unknown error"}`
          : "等待真实 stdio traffic。";

  return {
    trafficStatusLabel,
    trafficStatusClassName,
    lastUpdatedAt,
    trafficQuery,
    setTrafficQuery,
    directionFilter,
    setDirectionFilter,
    filteredFrames,
    selectedFrame,
    setSelectedFrameId,
    setIsFollowingLatest,
    trafficFrames,
    latestFrame,
    realTraffic,
    sourcePath,
    emptyTrafficMessage,
    linkedFrame,
    isFollowingLatest,
    isMockReplayEnabled,
    followLatest,
    stopMockReplay,
    startMockReplay,
    trafficSourceMode,
    refreshTrafficSource,
  };
}
