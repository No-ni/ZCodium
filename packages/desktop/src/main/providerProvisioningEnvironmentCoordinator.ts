import type { ProviderProvisioningTrigger } from "@zcode/shared";

type ExecuteSync = (trigger: ProviderProvisioningTrigger) => Promise<void>;

interface Registration {
  readonly id: string;
  readonly execute: ExecuteSync;
}

interface EnvironmentLane {
  readonly registrations: Map<string, Registration>;
  generation: number;
  completedGeneration: number;
  trigger: ProviderProvisioningTrigger;
  drain: Promise<void> | null;
}

/**
 * Main 进程只协调 Environment 身份和执行代际；配置与凭据始终由被选中的 Host 现读现传。
 */
export class ProviderProvisioningEnvironmentCoordinator {
  readonly #lanes = new Map<string, EnvironmentLane>();

  register(
    environmentKey: string,
    registrationId: string,
    execute: ExecuteSync,
  ): {
    initialSync: Promise<void>;
    dispose(): void;
  } {
    const lane = this.#lanes.get(environmentKey) ?? createLane();
    const wasOffline = lane.registrations.size === 0;
    const registration = { id: registrationId, execute };
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

  requestAll(trigger: Exclude<ProviderProvisioningTrigger, "environment-online">): Promise<void> {
    const drains: Promise<void>[] = [];
    for (const [environmentKey, lane] of this.#lanes) {
      if (lane.registrations.size === 0) continue;
      lane.generation += 1;
      lane.trigger = trigger;
      drains.push(this.#startDrain(environmentKey, lane));
    }
    return Promise.all(drains).then(() => undefined);
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
        // 迟到成功不能替新 Host 完成屏障，新注册必须从当前 Host 重新执行。
        if (lane.registrations.get(registration.id) === registration) {
          lane.completedGeneration = targetGeneration;
        }
      } catch (error) {
        if (lane.registrations.get(registration.id) !== registration) continue;
        if (trigger === "environment-online") {
          // 首次失败不是完成事实；失败执行者退出调度，后续显式连接重新执行。
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
