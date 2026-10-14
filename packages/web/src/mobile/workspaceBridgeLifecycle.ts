export interface WorkspaceBridgeTarget {
  workspaceKey: string;
  remoteSessionId?: string;
  taskId?: string;
}

type WorkspaceBridgeScope = Pick<WorkspaceBridgeTarget, "workspaceKey" | "remoteSessionId">;

function sameScope(left: WorkspaceBridgeScope, right: WorkspaceBridgeScope): boolean {
  // 远端重连可能保留 workspace identity，但会替换 Host 路由，因此必须比较 remoteSessionId。
  return left.workspaceKey === right.workspaceKey && left.remoteSessionId === right.remoteSessionId;
}

/** 单一桥所有者；串行 open，避免桌面单槽 bridge 被迟到握手替换。 */
export class WorkspaceBridgeLifecycle {
  private generation = 0;
  private readyScope: WorkspaceBridgeScope | null = null;
  private opening: { scope: WorkspaceBridgeScope; promise: Promise<void> } | null = null;
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

  isReady(scope: WorkspaceBridgeScope): boolean {
    return this.readyScope !== null && sameScope(this.readyScope, scope);
  }

  invalidate(): void {
    // A ready → B pending → A 时，旧 A ready 必须同步清掉，不能在第三步早退。
    this.generation += 1;
    this.readyScope = null;
    this.opening = null;
    this.onInvalidate();
  }

  ensure(target: WorkspaceBridgeTarget): Promise<void> {
    const scope = { workspaceKey: target.workspaceKey, remoteSessionId: target.remoteSessionId };
    if (this.isReady(scope)) return Promise.resolve();
    if (this.opening && sameScope(this.opening.scope, scope)) return this.opening.promise;
    this.invalidate();
    const generation = this.generation;
    const promise = this.tail.then(async () => {
      this.assertCurrent(generation);
      try {
        await this.open(target, generation);
        this.assertCurrent(generation);
        this.readyScope = scope;
      } catch (error) {
        // 握手失败不能留下半初始化 client；过时请求失败则不能再作废更新的目标。
        if (this.isCurrent(generation)) this.invalidate();
        throw error;
      }
    });
    this.tail = promise.catch(() => {});
    this.opening = { scope, promise };
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
