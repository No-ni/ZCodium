import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useZCodeAgentService } from "./useZCodeAgentService.js";
import type {
  NativeContextIdentity,
  NativeContextReadController,
  NativeContextStatus,
} from "@/native-context-compression/contract.js";
import {
  nativeContextScopeKey,
  nativeContextVersionKey,
} from "@/native-context-compression/domain/format.js";

interface ContextReadState {
  scopeKey: string;
  status: NativeContextStatus | null;
  loading: boolean;
  error: boolean;
}

/** attachment 与 Runtime query 是事实来源；此 hook 只持最后完整只读视图。 */
export function useNativeContextCompression(
  identity: NativeContextIdentity,
  options: { projection?: NativeContextStatus | null; disabled?: boolean } = {},
): NativeContextReadController {
  const { workspacePath, workspaceIdentity, remoteSessionId, sessionId } = identity;
  const service = useZCodeAgentService(workspacePath, remoteSessionId, workspaceIdentity);
  const scopeKey = nativeContextScopeKey(identity);
  const projection = options.projection ?? null;
  const [state, setState] = useState<ContextReadState>(() => ({
    scopeKey,
    status: null,
    loading: false,
    error: false,
  }));
  const ownedState = state.scopeKey === scopeKey ? state : null;
  const queriedStatus = ownedState?.status ?? null;
  const status =
    projection && (!queriedStatus || projection.revision >= queriedStatus.revision)
      ? projection
      : queriedStatus;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const statusRef = useRef(status);
  statusRef.current = status;
  const requestRef = useRef(0);
  const disabled = options.disabled === true;
  const projectionKey = projection
    ? `${nativeContextVersionKey(projection)}:${projection.phase}`
    : "";
  const requestIdentity = useMemo(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      sessionId: sessionId ?? "",
    }),
    [workspacePath, workspaceIdentity, sessionId],
  );

  const refresh = useCallback(async () => {
    if (!sessionId || disabled) return null;
    const request = ++requestRef.current;
    setState((current) => ({
      scopeKey,
      status: current.scopeKey === scopeKey ? current.status : null,
      loading: true,
      error: false,
    }));
    try {
      const result = await service.getContextCompression(requestIdentity);
      if (scopeRef.current !== scopeKey) return null;
      const current = statusRef.current;
      // 原因：ACK 与 snapshot 可并行到达；迟到 query 只能返回已采纳且更近的完整视图。
      if (requestRef.current !== request) {
        return current &&
          current.revision >= result.revision &&
          current.generation >= result.generation &&
          (current.revision !== result.revision ||
            nativeContextVersionKey(current) === nativeContextVersionKey(result))
          ? current
          : null;
      }
      // 原因：策略/世代已推进时，先发的 query 不能把新 snapshot 换回旧历史。
      if (
        current &&
        (result.revision < current.revision ||
          (result.revision === current.revision &&
            nativeContextVersionKey(result) !== nativeContextVersionKey(current)))
      ) {
        setState((value) => ({ ...value, loading: false }));
        return null;
      }
      setState({ scopeKey, status: result, loading: false, error: false });
      return result;
    } catch {
      if (scopeRef.current !== scopeKey || requestRef.current !== request) return null;
      setState((current) => ({
        scopeKey,
        status: current.scopeKey === scopeKey ? current.status : null,
        loading: false,
        error: true,
      }));
      return null;
    }
  }, [disabled, requestIdentity, scopeKey, service, sessionId]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh, projectionKey]);

  const captureRead = useCallback(() => {
    const current = statusRef.current;
    if (!sessionId || disabled || !current) throw new Error("native-context-unavailable");
    const version = nativeContextVersionKey(current);
    return {
      current,
      assertCurrent(result: { generation: number; historyVersion: string; revision: number }) {
        const latest = statusRef.current;
        if (
          scopeRef.current !== scopeKey ||
          !latest ||
          nativeContextVersionKey(latest) !== version ||
          result.generation !== current.generation ||
          result.historyVersion !== current.historyVersion ||
          result.revision !== current.revision
        )
          throw new Error("native-context-view-changed");
      },
    };
  }, [disabled, scopeKey, sessionId]);

  const observations: NativeContextReadController["observations"] = useCallback(
    async (page = {}) => {
      const read = captureRead();
      const result = await service.listContextObservations({
        ...requestIdentity,
        ...page,
        expectedRevision: read.current.revision,
      });
      read.assertCurrent(result);
      return result;
    },
    [captureRead, requestIdentity, service],
  );
  const records: NativeContextReadController["records"] = useCallback(
    async (page = {}) => {
      const read = captureRead();
      const result = await service.listContextCompressionRecords({
        ...requestIdentity,
        ...page,
        expectedRevision: read.current.revision,
      });
      read.assertCurrent(result);
      return result;
    },
    [captureRead, requestIdentity, service],
  );
  const record: NativeContextReadController["record"] = useCallback(
    async (operationId, page = {}) => {
      const read = captureRead();
      const result = await service.readContextCompressionRecord({
        ...requestIdentity,
        operationId,
        ...page,
        expectedRevision: read.current.revision,
      });
      // 祖先记录保留生成时的历史；分页围栏必须比较当前只读 view 的世代。
      read.assertCurrent({
        revision: result.revision,
        generation: result.viewGeneration,
        historyVersion: result.viewHistoryVersion,
      });
      if (result.operationId !== operationId) throw new Error("native-context-record-changed");
      return result;
    },
    [captureRead, requestIdentity, service],
  );
  const source: NativeContextReadController["source"] = useCallback(
    async (ref, offset = 0) => {
      const read = captureRead();
      const result = await service.readContextSource({
        ...requestIdentity,
        ref,
        offset,
        expectedRevision: read.current.revision,
        limitTokens: read.current.policy.parameters.retrieval.textPageTokens,
      });
      read.assertCurrent(result);
      if (result.ref !== ref || result.offset !== offset)
        throw new Error("native-context-source-changed");
      return result;
    },
    [captureRead, requestIdentity, service],
  );
  const image: NativeContextReadController["image"] = useCallback(
    async (ref) => {
      const read = captureRead();
      const first = await service.readContextImage({
        ...requestIdentity,
        ref,
        offset: 0,
        maxBytes: 512 * 1024,
        expectedRevision: read.current.revision,
      });
      read.assertCurrent(first);
      if (first.ref !== ref || first.offset !== 0) throw new Error("native-context-image-changed");
      if (!first.originalAvailable || !first.dataBase64 || !first.mediaType)
        return { ...first, blob: null };
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let page = first;
      let received = 0;
      while (true) {
        read.assertCurrent(page);
        if (
          !page.dataBase64 ||
          page.offset !== received ||
          page.ref !== first.ref ||
          page.mediaType !== first.mediaType ||
          page.originalBytes !== first.originalBytes
        )
          throw new Error("native-context-image-changed");
        const decoded = atob(page.dataBase64);
        const chunk = new Uint8Array(decoded.length);
        for (let index = 0; index < decoded.length; index += 1)
          chunk[index] = decoded.charCodeAt(index);
        if (chunk.length > 512 * 1024 || received + chunk.length > 32 * 1024 * 1024)
          throw new Error("native-context-image-capacity");
        chunks.push(chunk);
        received += chunk.length;
        if (page.nextOffset === null) break;
        if (page.nextOffset !== received || page.nextOffset <= page.offset)
          throw new Error("native-context-image-sequence");
        page = await service.readContextImage({
          ...requestIdentity,
          ref,
          offset: page.nextOffset,
          maxBytes: 512 * 1024,
          expectedRevision: read.current.revision,
        });
      }
      if (first.originalBytes !== null && received !== first.originalBytes)
        throw new Error("native-context-image-incomplete");
      return { ...first, blob: new Blob(chunks, { type: first.mediaType }) };
    },
    [captureRead, requestIdentity, service],
  );

  return {
    scopeKey,
    status,
    loading: ownedState?.loading ?? false,
    error: ownedState?.error ?? false,
    unavailable:
      disabled ||
      ownedState?.error === true ||
      status?.unavailableReason === "offline" ||
      status?.unavailableReason === "recovering",
    refresh,
    observations,
    records,
    record,
    source,
    image,
  };
}
