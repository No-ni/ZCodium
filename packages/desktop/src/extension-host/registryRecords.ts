import { mkdir } from "node:fs/promises";
import type { ContributionSnapshot } from "@zcode/shared/extension-host";
import {
  type CommandCall,
  type ExtensionDeclaration,
  type ExtensionModule,
  type ExtensionRunState,
  type SlotScopeKey,
  type SlotValue,
  type ViewDefinition,
  type ViewServerFactory,
} from "@zcode/shared/extension-host";
import { type ExtensionContextHandle } from "#src/extension-host/extensionContext.js";

// 扩展注册表：贡献表的唯一 owner（docs/plugins/extension-host.md §3.4、§6、§12.2、§13、§16.1）。
// 贡献表只有运行状态与插槽动态值：状态变化推整份快照；slots.update 推增量；两者共用 rev，每代际内单调递增。
// 静态声明归 Window Host：本进程不读 plugin.json，只收 Window Host 校验过的扩展声明。

const ACTIVATION_TIMEOUT_MS = 10_000;

interface ExtensionRecord {
  decl: ExtensionDeclaration;
  /** 声明变更判断：整份声明。设置值不在声明里（经能力 settings.* 读），设置变化不重启扩展。 */
  declKey: string;
  activationEvents: Set<string>;
  state: ExtensionRunState;
  reason?: string;
  activation: Promise<void> | null;
  context: ExtensionContextHandle | null;
  module: ExtensionModule | null;
  commands: Map<string, (call: CommandCall) => unknown>;
  views: Map<string, ViewDefinition | ViewServerFactory>;
  /** 本扩展已声明的条目全局 id。 */
  itemIds: Set<string>;
}

/** 激活期间的注册先缓存，成功返回后一起生效。 */
interface ActivationTransaction {
  commands: Map<string, (call: CommandCall) => unknown>;
  views: Map<string, ViewDefinition | ViewServerFactory>;
  values: Map<string, Map<SlotScopeKey, SlotValue | null>>;
}

/** 只读原注册表和动态值，rev 仍由 ExtensionRegistry 唯一推进。 */
export function buildContributionSnapshot(
  gen: number,
  rev: number,
  records: ReadonlyMap<string, ExtensionRecord>,
  dynamicValues: ReadonlyMap<string, ReadonlyMap<SlotScopeKey, SlotValue>>,
): ContributionSnapshot {
  const values: ContributionSnapshot["values"] = {};
  for (const [itemId, byScope] of dynamicValues) values[itemId] = Object.fromEntries(byScope);
  return {
    kind: "snapshot",
    gen,
    rev,
    extensions: [...records.values()].map((record) => ({
      pluginId: record.decl.pluginId,
      state: record.state,
      ...(record.reason ? { reason: record.reason } : {}),
    })),
    values,
  };
}

export function clearRecordSlotValues(
  values: Map<string, Map<SlotScopeKey, SlotValue>>,
  itemIds: ReadonlySet<string>,
) {
  for (const itemId of itemIds) values.delete(itemId);
}

function declarationKey(decl: ExtensionDeclaration): string {
  return JSON.stringify(decl);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 插件数据目录（docs/plugins/extension-host.md §18.1 H6）：激活前建好，扩展拿到时目录已存在。
 * 声明里没有它说明 plugins/list 来自不报告 dataPath 的旧 CLI。错误只带错误码：路径在用户目录下。
 */
async function ensureDataPath(dataPath: string | undefined): Promise<void> {
  if (!dataPath) throw new Error("the agent did not report the plugin data path; update ZCode");
  try {
    await mkdir(dataPath, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw new Error(`could not create the plugin data directory (${code ?? "error"})`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export {
  ACTIVATION_TIMEOUT_MS,
  type ExtensionRecord,
  type ActivationTransaction,
  declarationKey,
  withTimeout,
  ensureDataPath,
  describe,
};
