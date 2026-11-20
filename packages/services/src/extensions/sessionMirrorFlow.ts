import {
  ExtensionError,
  SESSION_EVENT_MAX_BYTES,
  SESSION_MIRROR_MAX_BYTES,
  isExtensionAnswerableInteraction,
  type SessionConversationEvent,
  type SessionInteractionsEvent,
  type SessionRowsEvent,
} from "@zcode/shared/extension-host";
import {
  applyConversationDeltas,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import {
  type SessionReadsDeps,
  type Target,
  type Registration,
  type Mirror,
  type Connection,
} from "./sessionReadTypes.js";
import { jsonBytes, describe } from "./sessionReadFacts.js";
// 镜像与登记集合属于 createSessionReads；实时 getter 防止换代后读到旧连接。
export function createSessionMirrorFlow(
  getConnection: () => Connection | null,
  mirrors: Map<string, Mirror>,
  registrations: Set<Registration>,
  logger: SessionReadsDeps["logger"],
) {
  // —— 镜像 ——

  const deliver = (
    mirror: Mirror,
    kind: Registration["kind"],
    event: unknown,
    only?: Registration,
  ) => {
    for (const registration of only ? [only] : mirror.registrations) {
      if (registration.kind !== kind || registration.disposed) continue;
      (registration.listener as (event: unknown) => void)(event);
    }
  };

  /** 行事件超过单个事件上限时改推 stale，插件用 readRows 补读。 */
  const deliverRows = (mirror: Mirror, event: SessionRowsEvent, only?: Registration) => {
    const sized =
      jsonBytes(event) > SESSION_EVENT_MAX_BYTES
        ? { kind: "stale" as const, logEpoch: event.logEpoch, revision: event.revision }
        : event;
    deliver(mirror, "rows", sized, only);
    logger.debug(
      undefined,
      `session rows ${sized.kind} session=${mirror.target.sessionId} rows=${sized.kind === "reset" ? sized.rows.length : sized.kind === "rows" ? sized.upserted.length : 0}`,
    );
  };

  const resetEvent = (snapshot: ConversationSnapshot): SessionRowsEvent => ({
    kind: "reset",
    logEpoch: snapshot.logEpoch,
    revision: snapshot.revision,
    rows: snapshot.rows.window,
  });

  const stateOf = (mirror: Mirror, snapshot: ConversationSnapshot): SessionConversationEvent => ({
    sessionId: mirror.target.sessionId,
    logEpoch: snapshot.logEpoch,
    revision: snapshot.revision,
    phase: snapshot.control.phase,
  });

  /** 交互投影：只留工具审批与提问（§17.12）；Hook 信任审查与插件安装确认不给插件看。 */
  const interactionsOf = (
    mirror: Mirror,
    snapshot: ConversationSnapshot,
  ): SessionInteractionsEvent => ({
    sessionId: mirror.target.sessionId,
    logEpoch: snapshot.logEpoch,
    revision: snapshot.revision,
    mode: snapshot.config.mode,
    interactions: snapshot.pendingInteractions.filter((interaction) =>
      isExtensionAnswerableInteraction(interaction.kind),
    ),
  });

  const publishState = (mirror: Mirror, snapshot: ConversationSnapshot) => {
    const state = stateOf(mirror, snapshot);
    const key = `${state.logEpoch}\0${state.revision}\0${state.phase}`;
    if (key !== mirror.stateKey) {
      mirror.stateKey = key;
      deliver(mirror, "conversation", state);
    }
    const interactions = interactionsOf(mirror, snapshot);
    const interactionsKey = JSON.stringify([interactions.mode, interactions.interactions]);
    if (interactionsKey === mirror.interactionsKey) return;
    mirror.interactionsKey = interactionsKey;
    deliver(mirror, "interactions", interactions);
  };

  /** 按窗口里各行的 JSON 字节控制镜像大小：超过预算时从最旧的行丢起（仍可经 readRows 读到）。 */
  const fitBudget = (mirror: Mirror, snapshot: ConversationSnapshot, changed?: Set<number>) => {
    if (!changed) {
      mirror.rowBytes.clear();
      mirror.totalBytes = 0;
    }
    for (const row of snapshot.rows.window) {
      if (changed && !changed.has(row.rowId)) continue;
      const bytes = jsonBytes(row);
      mirror.totalBytes += bytes - (mirror.rowBytes.get(row.rowId) ?? 0);
      mirror.rowBytes.set(row.rowId, bytes);
    }
    let drop = 0;
    const window = snapshot.rows.window;
    while (mirror.totalBytes > SESSION_MIRROR_MAX_BYTES && drop < window.length - 1) {
      const row = window[drop]!;
      mirror.totalBytes -= mirror.rowBytes.get(row.rowId) ?? 0;
      mirror.rowBytes.delete(row.rowId);
      drop += 1;
    }
    if (drop === 0) return snapshot;
    logger.debug(
      undefined,
      `session mirror trimmed session=${mirror.target.sessionId} rows=${drop}`,
    );
    return { ...snapshot, rows: { ...snapshot.rows, window: window.slice(drop) } };
  };

  const applyFrame = (mirror: Mirror, frame: ConversationTopicFrame) => {
    if (frame.payload.kind === "snapshot") {
      const next = frame.payload.snapshot;
      if (next.sessionId !== mirror.target.sessionId) return;
      mirror.subscriptionId ??= frame.subscriptionId;
      mirror.phase = "live";
      const snapshot = fitBudget(mirror, next);
      mirror.snapshot = snapshot;
      deliverRows(mirror, resetEvent(snapshot));
      publishState(mirror, snapshot);
      return;
    }
    // 重同步期间的增量跟不上镜像水位，等下一个 snapshot。
    const current = mirror.snapshot;
    if (mirror.phase !== "live" || !current) return;
    if (frame.fromSeq !== current.seq || frame.toSeq <= frame.fromSeq) {
      resync(mirror, "sequence gap");
      return;
    }
    const changed = new Set<number>();
    let removed = false;
    for (const delta of frame.payload.deltas) {
      if (delta.op === "row.appended" || delta.op === "row.upserted") changed.add(delta.row.rowId);
      else if (delta.op === "row.delta") changed.add(delta.rowId);
      else if (delta.op === "row.removed") removed = true;
    }
    const applied = { ...applyConversationDeltas(current, frame.payload.deltas), seq: frame.toSeq };
    const snapshot = fitBudget(mirror, applied, removed ? undefined : changed);
    mirror.snapshot = snapshot;
    if (removed) {
      // 行被删除（回退、压缩改写）：不单独推删除，整窗 reset。
      deliverRows(mirror, resetEvent(snapshot));
    } else if (changed.size > 0) {
      const upserted: ConversationRow[] = snapshot.rows.window.filter((row) =>
        changed.has(row.rowId),
      );
      if (upserted.length > 0)
        deliverRows(mirror, {
          kind: "rows",
          logEpoch: snapshot.logEpoch,
          revision: snapshot.revision,
          upserted,
        });
    }
    publishState(mirror, snapshot);
  };

  const acceptWire = (mirror: Mirror, wire: ConversationTopicWireCandidate) => {
    if (mirror.phase === "closed" || mirror.phase === "detached") return;
    if (mirror.subscriptionId && wire.subscriptionId !== mirror.subscriptionId) return;
    for (const event of mirror.assembler.accept(wire)) {
      if (event.kind === "fault") {
        logger.warn(
          undefined,
          `session mirror frame rejected session=${mirror.target.sessionId} reason=${event.fault.reasonCode}`,
        );
        resync(mirror, "assembly fault");
        return;
      }
      applyFrame(mirror, event.frame);
    }
  };

  /** 镜像不能恢复：它的订阅都以 unavailable 结束，镜像释放。 */
  const failMirror = (mirror: Mirror, reason: string) => {
    logger.warn(undefined, `session mirror failed session=${mirror.target.sessionId} (${reason})`);
    const error = new ExtensionError("unavailable", "the session is not available to read");
    for (const registration of mirror.registrations) {
      registration.disposed = true;
      registrations.delete(registration);
      registration.fail(error);
    }
    mirror.registrations.clear();
    closeMirror(mirror, true);
  };

  const subscribe = (mirror: Mirror, reason: string) => {
    const current = getConnection();
    if (!current || mirror.phase === "closed") return;
    mirror.attempt += 1;
    const attempt = mirror.attempt;
    mirror.phase = "subscribing";
    mirror.subscriptionId = null;
    mirror.assembler.clear();
    void (async () => {
      await current.ready;
      const result = await current.scope.service.subscribeConversationV4({
        workspacePath: mirror.target.workspacePath,
        ...(mirror.target.workspaceIdentity
          ? { workspaceIdentity: mirror.target.workspaceIdentity }
          : {}),
        sessionId: mirror.target.sessionId,
        visibility: "background",
      });
      if (attempt !== mirror.attempt || mirror.phase === "closed" || getConnection() !== current) {
        void unsubscribeQuietly(current, mirror.target, result.ack.subscriptionId);
        return;
      }
      mirror.subscriptionId = result.ack.subscriptionId;
      logger.info(
        undefined,
        `session mirror subscribed session=${mirror.target.sessionId} connectionId=extension-host:${current.gen} mode=${result.ack.mode} (${reason})`,
      );
    })().catch((error: unknown) => {
      if (attempt !== mirror.attempt || mirror.phase === "closed" || getConnection() !== current)
        return;
      failMirror(mirror, `subscribe failed: ${describe(error)}`);
    });
  };

  const resync = (mirror: Mirror, reason: string) => {
    const current = getConnection();
    const subscriptionId = mirror.subscriptionId;
    if (!current || mirror.phase !== "live" || !subscriptionId) return;
    mirror.phase = "resyncing";
    const attempt = mirror.attempt;
    // 与 Renderer 相同：RPC 前先清掉这条路由的组装状态，迟到的旧残片照常丢弃。
    mirror.assembler.abort(mirror.topic, subscriptionId);
    logger.info(undefined, `session mirror resync session=${mirror.target.sessionId} (${reason})`);
    void current.scope.service
      .resyncConversationV4({
        workspacePath: mirror.target.workspacePath,
        ...(mirror.target.workspaceIdentity
          ? { workspaceIdentity: mirror.target.workspaceIdentity }
          : {}),
        subscriptionId,
        base: null,
        forceSnapshot: true,
      })
      .catch((error: unknown) => {
        if (attempt !== mirror.attempt || mirror.phase === "closed") return;
        failMirror(mirror, `resync failed: ${describe(error)}`);
      });
  };

  const unsubscribeQuietly = async (
    current: Connection,
    target: Target,
    subscriptionId: string,
  ) => {
    try {
      await current.scope.service.unsubscribeConversationV4({
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        subscriptionId,
      });
    } catch (error) {
      logger.debug(undefined, `session mirror unsubscribe failed (${describe(error)})`);
    }
  };

  /** 释放镜像。unsubscribe 为 false 时由 scope.dispose() 统一退订（换代）。 */
  const closeMirror = (mirror: Mirror, unsubscribe: boolean) => {
    if (mirror.phase === "closed") return;
    const subscriptionId = mirror.subscriptionId;
    mirror.phase = "closed";
    mirror.attempt += 1;
    mirror.assembler.clear();
    mirror.snapshot = null;
    mirrors.delete(mirror.key);
    const current = getConnection();
    if (unsubscribe && current && subscriptionId)
      void unsubscribeQuietly(current, mirror.target, subscriptionId);
    logger.info(undefined, `session mirror released session=${mirror.target.sessionId}`);
  };
  return {
    deliver,
    deliverRows,
    resetEvent,
    stateOf,
    interactionsOf,
    publishState,
    fitBudget,
    applyFrame,
    acceptWire,
    failMirror,
    subscribe,
    resync,
    unsubscribeQuietly,
    closeMirror,
  };
}
