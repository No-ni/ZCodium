export interface WorkspaceBridgeTarget {
  workspaceKey: string;
  taskId?: string;
}

/** 单一桥所有者；串行 open，避免桌面单槽 bridge 被迟到握手替换。 */
export class WorkspaceBridgeLifecycle {
  private generation = 0;
  private readyKey: string | null = null;
  private opening: { key: string; promise: Promise<void> } | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly onInvalidate: () => void,
    private readonly open: (target: WorkspaceBridgeTarget, generation: number) => Promise<void>,
  ) {}

  get version(): number {
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  isReady(key: string): boolean {
    return this.readyKey === key;
  }

  invalidate(): void {
    // A ready → B pending → A 时，旧 A ready 必须同步清掉，不能在第三步早退。
    this.generation += 1;
    this.readyKey = null;
    this.opening = null;
    this.onInvalidate();
  }

  ensure(target: WorkspaceBridgeTarget): Promise<void> {
    if (this.isReady(target.workspaceKey)) return Promise.resolve();
    if (this.opening?.key === target.workspaceKey) return this.opening.promise;
    this.invalidate();
    const generation = this.generation;
    const promise = this.tail.then(async () => {
      this.assertCurrent(generation);
      try {
        await this.open(target, generation);
        this.assertCurrent(generation);
        this.readyKey = target.workspaceKey;
      } catch (error) {
        // 握手失败不能留下半初始化 client；过时请求失败则不能再作废更新的目标。
        if (this.isCurrent(generation)) this.invalidate();
        throw error;
      }
    });
    this.tail = promise.catch(() => {});
    this.opening = { key: target.workspaceKey, promise };
    void promise
      .finally(() => {
        if (this.opening?.promise === promise) this.opening = null;
      })
      .catch(() => {});
    return promise;
  }

  assertCurrent(generation: number): void {
    if (!this.isCurrent(generation)) throw new Error("workspace bridge superseded");
  }
}
