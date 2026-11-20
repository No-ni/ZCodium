import { type Event } from "@zcode/rpc";
import {
  extensionActivationHoldSchema,
  extensionGrantSchema,
  type ExtensionActivationHold,
  type ExtensionGrant,
  type ExtensionGrantsSnapshot,
  type ExtensionStaticTable,
  type StaticPlugin,
} from "@zcode/shared/extension-host";
import { z } from "zod";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

// 授权记录（docs/plugins/extension-host.md §17.7）：唯一 owner 是本服务，文件
// `~/.zcode/v2/extensions/grants.json`。没有记录就拒绝。卸载删除记录，禁用不删。
//
//   grants.json（记录）⊕ 静态表（清单声明的档位与版本）──► 生效档位 + 整份授权状态（带 rev）
//
// 插件更新（静态表重读）时按清单重算：声明没有超出记录 → 不再询问，静默记下新版本；声明变多 → 回到待授权
// （会话能力报 not-granted），记录保留，等用户确认；声明变少 → 记录自动收窄。
// 记录的 consentRevision 低于当前值、声明覆盖 sessions.write → 同样回到待授权（§17.12，会话档位含义变宽）。
// 生效档位只按「记录 ⊕ 最近一份静态表」现算，不维护第二份。

const GRANTS_FILE_VERSION = 1;

const grantRecordSchema = z.object({
  grants: z.array(extensionGrantSchema),
  consentedVersion: z.string().optional(),
  consentedAt: z.number().int().nonnegative(),
  /** 同意时会话档位含义的版本（§17.12）；旧文件没有这个字段，按 1 处理。 */
  consentRevision: z.number().int().positive().optional(),
  /** 详情页「系统通知」开关关了（§18.1 H8）；没有这个字段按开处理，旧文件照常读。 */
  notificationsOff: z.literal(true).optional(),
});

type GrantRecord = z.infer<typeof grantRecordSchema>;

/** 从插件商店安装后、激活前的确认（§17.7，P3b）：pending 等用户确认，declined 用户选择不激活。 */
const activationRecordSchema = z.object({
  state: extensionActivationHoldSchema,
  version: z.string().optional(),
  at: z.number().int().nonnegative(),
});

type ActivationRecord = z.infer<typeof activationRecordSchema>;

const grantsFileSchema = z.object({
  version: z.literal(GRANTS_FILE_VERSION),
  plugins: z.record(z.string(), grantRecordSchema),
  // 可选键（P3b）：旧文件没有它照常读。
  activations: z.record(z.string(), activationRecordSchema).optional(),
});

export interface GrantsStoreDeps {
  filePath: string;
  logger: Pick<ServiceLogger, "info" | "warn">;
  now?: () => number;
}

export interface GrantsStore {
  /** 读完 grants.json 后 resolve（读不出时按没有记录处理，不 reject）。 */
  readonly ready: Promise<void>;
  /** 整份授权状态的变化（rev 递增）。 */
  readonly onDidChange: Event<ExtensionGrantsSnapshot>;
  snapshot(): ExtensionGrantsSnapshot;
  /** 当前是否授予了覆盖该档位的权限（记录 ⊕ 最近一份静态表）。 */
  covers(pluginId: string, grant: ExtensionGrant): boolean;
  /**
   * 静态表重读后调用：按清单收窄记录、静默记下新版本。返回生效档位变少的插件（调用方中止它们在途的调用）。
   */
  reconcile(table: ExtensionStaticTable): string[];
  /**
   * 用户确认授权：grants 必须等于清单当前声明的档位。写文件后调 afterCommit（写审计），再发布新状态。
   * 返回授予的档位。
   */
  grant(
    pluginId: string,
    grants: readonly ExtensionGrant[],
    afterCommit?: (tiers: ExtensionGrant[]) => Promise<void>,
  ): Promise<ExtensionGrant[]>;
  /** 撤销并删除记录（卸载也走这里），顺序同 grant。返回被撤销的档位；没有记录时为空。 */
  revoke(
    pluginId: string,
    afterCommit?: (tiers: ExtensionGrant[]) => Promise<void>,
  ): Promise<ExtensionGrant[]>;
  /**
   * 详情页「系统通知」开关（§18.1 H8）：只在通知档位生效时可改。顺序同 grant（写文件 → afterCommit → 发布）。
   * 返回是否改了（值没变时 false，不写文件）。
   */
  setNotificationsEnabled(
    pluginId: string,
    enabled: boolean,
    afterCommit?: () => Promise<void>,
  ): Promise<boolean>;
  /** 持有生效会话权限的插件（启用确认用，只看会话档位），不含 exclude。 */
  holders(exclude?: string): Array<{ pluginId: string; name: string; granted: ExtensionGrant[] }>;
  /** 该插件是否在等待激活确认（pending）或用户选择了不激活（declined）。 */
  activationHold(pluginId: string): ExtensionActivationHold | undefined;
  /** 商店安装后先不激活（§17.7）：记为 pending 并写文件。 */
  holdActivation(pluginId: string, version: string | undefined): Promise<void>;
  /** 用户的决定：allow 删除记录（激活），否则记为 declined。没有 pending 记录时返回 false。 */
  decideActivation(pluginId: string, allow: boolean): Promise<boolean>;
  /** 删除记录（设置页重新启用、卸载）。没有记录时返回 false。 */
  clearActivation(pluginId: string): Promise<boolean>;
  dispose(): void;
}

function okExtension(plugin: StaticPlugin | undefined) {
  return plugin?.extension?.state === "ok" ? plugin.extension : null;
}
export {
  GRANTS_FILE_VERSION,
  grantRecordSchema,
  type GrantRecord,
  activationRecordSchema,
  type ActivationRecord,
  grantsFileSchema,
  okExtension,
};
