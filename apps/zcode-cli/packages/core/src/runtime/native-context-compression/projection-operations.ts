import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import { NativeContextRuntimeError } from "./contract.js";
import { kernelOf, type NativeKernelData } from "./state.js";

type ProjectionOperations = NonNullable<NativeKernelData["projectionOperations"]>;

export function nativeProjectionOperations(
  state: NativeContextStoredState,
): ProjectionOperations | undefined {
  const operations = kernelOf(state).projectionOperations;
  if (operations === undefined) return undefined;
  if (operations === null || typeof operations !== "object" || Array.isArray(operations))
    throw new NativeContextRuntimeError("invalid-state", "projection-operations");
  for (const entries of [operations.blocks, operations.views]) {
    if (
      !entries ||
      typeof entries !== "object" ||
      Array.isArray(entries) ||
      Object.entries(entries).some(
        ([key, id]) => !key || key.length > 240 || typeof id !== "string" || !id || id.length > 240,
      )
    )
      throw new NativeContextRuntimeError("invalid-state", "projection-operations");
  }
  return operations;
}

/** 关系只在转换候选的同一 CAS 中生效；pending 的首次消费不能代表摘要已失效。 */
export function bindNativeProjectionOperation(
  state: NativeContextStoredState,
  operationId: string,
  affected: { blockIds?: readonly string[]; rawIds?: readonly string[] },
): void {
  const kernel = kernelOf(state);
  const operations = nativeProjectionOperations(state) ?? { blocks: {}, views: {} };
  const blockIds = new Set(kernel.compression.blocks.map((block) => block.blockId));
  for (const id of affected.blockIds ?? [])
    if (blockIds.has(id)) operations.blocks[id] = operationId;
  for (const id of affected.rawIds ?? []) if (kernel.views[id]) operations.views[id] = operationId;
  kernel.projectionOperations = operations;
  pruneNativeProjectionOperations(state);
}

export function pruneNativeProjectionOperations(
  state: NativeContextStoredState,
  allowedOperationIds?: ReadonlySet<string>,
): void {
  const operations = nativeProjectionOperations(state);
  if (!operations) return;
  const kernel = kernelOf(state);
  const blocks = new Set(kernel.compression.blocks.map((block) => block.blockId));
  const allowed = (id: string) => !allowedOperationIds || allowedOperationIds.has(id);
  kernel.projectionOperations = {
    blocks: Object.fromEntries(
      Object.entries(operations.blocks).filter(
        ([id, operationId]) => blocks.has(id) && allowed(operationId),
      ),
    ),
    views: Object.fromEntries(
      Object.entries(operations.views).filter(
        ([id, operationId]) => Boolean(kernel.views[id]) && allowed(operationId),
      ),
    ),
  };
}

/** raw 与 operation 分两层重映射，避免 boundary-state 反向依赖记录模块。 */
export function remapNativeProjectionRawIds(
  state: NativeContextStoredState,
  remap: (rawId: string) => string,
): void {
  const operations = nativeProjectionOperations(state);
  if (!operations) return;
  kernelOf(state).projectionOperations = {
    blocks: { ...operations.blocks },
    views: Object.fromEntries(
      Object.entries(operations.views).map(([rawId, id]) => [remap(rawId), id]),
    ),
  };
}

export function remapNativeProjectionOperationIds(
  state: NativeContextStoredState,
  ids: ReadonlyMap<string, string>,
): void {
  const operations = nativeProjectionOperations(state);
  if (!operations) return;
  const remap = (entries: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(entries).flatMap(([key, id]) => (ids.has(id) ? [[key, ids.get(id)!]] : [])),
    );
  kernelOf(state).projectionOperations = {
    blocks: remap(operations.blocks),
    views: remap(operations.views),
  };
  pruneNativeProjectionOperations(state);
}
