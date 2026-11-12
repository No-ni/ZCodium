import type {
  NativeContextCommit,
  NativeContextForkBundle,
  NativeContextObservation,
  NativeContextOperation,
  NativeContextOperationSummary,
  NativeContextPage,
  NativeContextPageRequest,
  NativeContextStoredState,
} from "@zcode/shared/native-context-compression";

export {
  NativeContextStoreConflictError,
  type NativeContextStoreConflictReason,
} from "@zcode/contracts";

export type NativeContextPageQuery = Omit<NativeContextPageRequest, "sessionId">;

/** 同一个 DatabaseSync 连接的同步边界，事务内不让出执行权。 */
export interface NativeContextSqliteRepository {
  getState(sessionId: string): NativeContextStoredState | null;
  commit(sessionId: string, commit: NativeContextCommit): void;
  listObservations(
    sessionId: string,
    request: NativeContextPageQuery,
  ): NativeContextPage<NativeContextObservation>;
  listOperations(
    sessionId: string,
    request: NativeContextPageQuery,
  ): NativeContextPage<NativeContextOperationSummary>;
  getOperation(sessionId: string, operationId: string): NativeContextOperation | null;
  getForkBundle(
    sessionId: string,
    options?: { allowStaleGeneration?: boolean },
  ): NativeContextForkBundle | null;
  /** 调用方已经持有 fork 的事务；这里不 BEGIN/COMMIT，也不执行业务 remap/filter。 */
  writeForkBundleInTransaction(sessionId: string, bundle: NativeContextForkBundle): void;
}
