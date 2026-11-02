import type { ConnectionProfile, RemoteTarget } from "@zcode/shared";
import type { Flight, OnlineSource, ManagedSourceHandle } from "./sourceServerConnectionTypes.js";

// 集合由 Manager 唯一持有；帮助函数只操作调用时传入的同一代际对象。
export function createSourceConnectionFlight(
  profile: ConnectionProfile,
  target: RemoteTarget,
  key: string,
  expectedSourceServerId: string | undefined,
  flights: Map<string, Flight>,
  activeFlights: Set<Flight>,
  connect: (
    profile: ConnectionProfile,
    target: RemoteTarget,
    signal: AbortSignal,
    expectedSourceServerId?: string,
  ) => Promise<OnlineSource>,
): Flight {
  const controller = new AbortController();
  const flight: Flight = {
    profile,
    controller,
    waiters: 0,
    settled: false,
    expectedSourceServerId,
    promise: Promise.resolve().then(() =>
      connect(profile, target, controller.signal, expectedSourceServerId),
    ),
  };
  flight.promise = flight.promise.finally(() => {
    flight.settled = true;
    activeFlights.delete(flight);
    if (flights.get(key) === flight) flights.delete(key);
  });
  flights.set(key, flight);
  activeFlights.add(flight);
  return flight;
}

export async function joinSourceConnectionFlight(
  flight: Flight,
  signal?: AbortSignal,
): Promise<OnlineSource> {
  flight.waiters += 1;
  let abort: (() => void) | undefined;
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Source connection canceled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    return await Promise.race([flight.promise, canceled]);
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    flight.waiters -= 1;
    // 一个 attachment 取消不能中断共享握手；只有最后一位等待者退出才退休准备代际。
    if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
  }
}

export function releaseManagedSource(
  source: OnlineSource,
  activeDisposals: Set<Promise<void>>,
): Promise<void> {
  if (source.disposal) return source.disposal;
  source.closeSubscription?.dispose();
  source.connection.dispose();
  const disposal = source.transport.dispose().finally(() => activeDisposals.delete(disposal));
  source.disposal = disposal;
  activeDisposals.add(disposal);
  return source.disposal;
}

export function createManagedSourceHandle(
  source: OnlineSource,
  current: ConnectionProfile,
): ManagedSourceHandle {
  source.references += 1;
  let released = false;
  const captured = source;
  return {
    sourceServerId: captured.connection.serverInfo.serverId,
    profile: current,
    services: captured.connection.services,
    workspaceInspection: captured.connection.workspaceInspection,
    backend: captured.transport.backend,
    onDidClose: captured.connection.onDidClose,
    async dispose() {
      if (released) return;
      released = true;
      captured.references -= 1;
    },
  };
}
