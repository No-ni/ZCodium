import type {
  ProviderProvisioningErrorCode,
  ProviderProvisioningLaneStatus,
  ProviderProvisioningSourceTrigger,
  ProviderProvisioningTrigger,
} from "@zcode/shared";

type ExecuteSync = (trigger: ProviderProvisioningTrigger) => Promise<void>;

type LaneResult = NonNullable<
  Extract<ProviderProvisioningLaneStatus, { lane: "present" }>["lastResult"]
>;

interface Registration {
  readonly id: string;
  readonly execute: ExecuteSync;
  /** 该注册所属的 Source 设备；数据同步页按它找到 lane。旧格式连接没有 sourceServerId。 */
  readonly sourceServerId?: string;
}

interface EnvironmentLane {
  readonly registrations: Map<string, Registration>;
  generation: number;
  completedGeneration: number;
  trigger: ProviderProvisioningTrigger;
  drain: Promise<void> | null;
  /** 最近一次真正完成（未被其它注册接管）的执行结果；只在内存中，不持久化。 */
  lastResult?: LaneResult;
}

/** 执行端带固定阶段码的失败；协调器只记录阶段码，不记录远端自由文本。 */
export class ProviderProvisioningExecutionError extends Error {
  constructor(
    message: string,
    readonly errorCode: ProviderProvisioningErrorCode,
  ) {
    super(message);
    this.name = "ProviderProvisioningExecutionError";
  }
}

/**
 * Main 进程只协调 Environment 身份和执行代际；配置与凭据始终由被选中的 Host 现读现传。
 *
 * 数据同步页的最近结果与重试（docs/remote/data-sync.md「模型提供商（只读）」）都以 lane 为唯一数据源：
 *
 * ```text
 * register / requestAll / retry ──▶ lane.generation += 1 ──▶ #startDrain（single-flight）
 *                                                            └─ #drain 循环到 completedGeneration == generation
 *                                                                 每次执行结束 ──▶ lane.lastResult = {at, outcome, errorCode?}
 * getLaneStatus(sourceServerId) ──▶ 找到有该设备注册的 lane ──▶ { running: 任一 drain != null, 最新的 lastResult }
 * ```
 *
 * 重试只是再推进一次同一条 lane 的 generation：执行中重试会合并进当前 drain 的尾随同步，
 * 不新增第二条同步链路，也没有自动重试或超时放行。合并进的首次上线失败时 drain 提前结束，
 * 由重试自己再起一轮执行本次代际（见 retry）。
 */
export class ProviderProvisioningEnvironmentCoordinator {
  readonly #lanes = new Map<string, EnvironmentLane>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  register(
    environmentKey: string,
    registrationId: string,
    execute: ExecuteSync,
    sourceServerId?: string,
  ): {
    initialSync: Promise<void>;
    dispose(): void;
  } {
    const lane = this.#lanes.get(environmentKey) ?? createLane();
    const wasOffline = lane.registrations.size === 0;
    const registration: Registration = {
      id: registrationId,
      execute,
      ...(sourceServerId ? { sourceServerId } : {}),
    };
    lane.registrations.set(registrationId, registration);
    this.#lanes.set(environmentKey, lane);
    if (wasOffline) {
      lane.generation += 1;
      lane.trigger = "environment-online";
    }
    const initialSync = this.#startDrain(environmentKey, lane);
    return {
      initialSync,
      dispose: () => {
        // 同 ID 可以换代；旧连接的清理只能退休自己的注册对象。
        if (lane.registrations.get(registrationId) !== registration) return;
        lane.registrations.delete(registrationId);
        this.#retireOfflineLane(environmentKey, lane);
      },
    };
  }

  requestAll(trigger: ProviderProvisioningSourceTrigger): Promise<void> {
    const drains: Promise<void>[] = [];
    for (const [environmentKey, lane] of this.#lanes) {
      if (lane.registrations.size === 0) continue;
      lane.generation += 1;
      lane.trigger = trigger;
      drains.push(this.#startDrain(environmentKey, lane));
    }
    return Promise.all(drains).then(() => undefined);
  }

  /**
   * 按设备查询 lane 状态。`waitForIdle` 时等当前 drain（含尾随同步）结束再返回，
   * 让打开时正处于执行中的页面拿到这次执行的结果，不靠轮询或超时。
   */
  async getLaneStatus(
    sourceServerId: string,
    options: { waitForIdle?: boolean } = {},
  ): Promise<ProviderProvisioningLaneStatus> {
    if (options.waitForIdle) {
      await Promise.all(
        this.#findLanes(sourceServerId).map(([, lane]) => lane.drain?.catch(() => undefined)),
      );
    }
    return this.#readStatus(sourceServerId);
  }

  /**
   * 用户重试：只在设备有 lane 时推进该设备 lane 的 generation（trigger 为 `user-retry`），
   * 等这次推进的代际执行完后返回最新状态。没有 lane 时不执行任何同步。
   */
  async retry(sourceServerId: string): Promise<ProviderProvisioningLaneStatus> {
    const lanes = this.#findLanes(sourceServerId);
    if (lanes.length === 0) return { lane: "none" };
    await Promise.all(
      lanes.map(async ([environmentKey, lane]) => {
        lane.generation += 1;
        lane.trigger = "user-retry";
        const target = lane.generation;
        // 修复：重试合并进正在执行的首次上线 drain 时，首次失败会从 drain 直接抛出并结束
        // （首连发布屏障，不能等尾随代际），重试推进的代际没有被执行，却返回了首次的失败结果。
        // 修法：drain 结束后本次代际仍未完成就再起一轮；每轮都会推进 completedGeneration
        // 或因注册清空而结束，不会空转。
        while (lane.completedGeneration < target && lane.registrations.size > 0) {
          // 首次上线的失败已记录在 lane 上，这里只等执行结束。
          await this.#startDrain(environmentKey, lane).catch(() => undefined);
        }
      }),
    );
    return this.#readStatus(sourceServerId);
  }

  /**
   * 同一 Source 经不同线路连接会形成不同 lane（Environment key 按 transport 派生，见 R3 §8.3.2），
   * 所以一个设备可能对应多条 lane；只认当前仍有该设备注册的 lane。
   */
  #findLanes(sourceServerId: string): Array<[string, EnvironmentLane]> {
    return [...this.#lanes.entries()].filter(([, lane]) =>
      [...lane.registrations.values()].some(
        (registration) => registration.sourceServerId === sourceServerId,
      ),
    );
  }

  /** 多条 lane 时：任一在执行即 running；最近结果取时间最新的一条。 */
  #readStatus(sourceServerId: string): ProviderProvisioningLaneStatus {
    const lanes = this.#findLanes(sourceServerId);
    if (lanes.length === 0) return { lane: "none" };
    let lastResult: LaneResult | undefined;
    for (const [, lane] of lanes) {
      if (lane.lastResult && (!lastResult || lane.lastResult.at >= lastResult.at)) {
        lastResult = lane.lastResult;
      }
    }
    return {
      lane: "present",
      running: lanes.some(([, lane]) => lane.drain !== null),
      ...(lastResult ? { lastResult: { ...lastResult } } : {}),
    };
  }

  #startDrain(environmentKey: string, lane: EnvironmentLane): Promise<void> {
    if (lane.drain) return lane.drain;
    if (lane.completedGeneration >= lane.generation || lane.registrations.size === 0) {
      return Promise.resolve();
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // execute 的同步部分也可能发出新触发，必须先登记 flight，不能并行执行同一 Environment。
    lane.drain = promise;
    const failed = (error: unknown) => {
      lane.drain = null;
      this.#retireOfflineLane(environmentKey, lane);
      reject(error);
    };
    const completed = () => {
      if (lane.completedGeneration < lane.generation && lane.registrations.size > 0) {
        void this.#drain(lane).then(completed, failed);
        return;
      }
      lane.drain = null;
      this.#retireOfflineLane(environmentKey, lane);
      resolve();
    };
    void this.#drain(lane).then(completed, failed);
    return promise;
  }

  #retireOfflineLane(environmentKey: string, lane: EnvironmentLane): void {
    // 未结算 apply 仍占串行通道；结算后空 lane 不再保留离线代际。
    if (!lane.drain && lane.registrations.size === 0 && this.#lanes.get(environmentKey) === lane) {
      this.#lanes.delete(environmentKey);
    }
  }

  async #drain(lane: EnvironmentLane): Promise<void> {
    while (lane.completedGeneration < lane.generation && lane.registrations.size > 0) {
      const targetGeneration = lane.generation;
      const trigger = lane.trigger;
      const registration = lane.registrations.values().next().value as Registration | undefined;
      if (!registration) return;
      try {
        await registration.execute(trigger);
        // 合并后的设备状态仍须以注册对象为准，迟到回包不能替同 ID 的新 Host 开屏障。
        if (lane.registrations.get(registration.id) !== registration) continue;
        lane.completedGeneration = targetGeneration;
        lane.lastResult = { at: this.#now(), outcome: "success" };
      } catch (error) {
        // 执行 Host 退出时，其注册会先被移除；同一 Environment 仍有其它 Host
        // 就立即接管当前代际。普通远端失败不自动重试，等待下一次正式触发或用户重试。
        if (lane.registrations.get(registration.id) !== registration) continue;
        lane.lastResult = {
          at: this.#now(),
          outcome: "failed",
          errorCode:
            error instanceof ProviderProvisioningExecutionError
              ? error.errorCode
              : "host-execution-failed",
        };
        // 首次同步是 Remote Workspace 发布屏障，不能把失败吞成已就绪；
        // 已连接后的同步失败只记录在 lane 上，不会从这里抛出。
        if (trigger === "environment-online") {
          // 首次失败的执行者不留作已上线事实，后续显式连接必须重走当前 Host 的授权屏障。
          lane.registrations.delete(registration.id);
          throw error;
        }
        lane.completedGeneration = targetGeneration;
      }
    }
  }
}

function createLane(): EnvironmentLane {
  return {
    registrations: new Map(),
    generation: 0,
    completedGeneration: 0,
    trigger: "environment-online",
    drain: null,
  };
}
