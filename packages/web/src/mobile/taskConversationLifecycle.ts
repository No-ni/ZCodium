import {
  SessionDataLayer,
  type ConversationStoreState,
  type ConversationTransport,
  type SessionLease,
} from "@zcode/ui/conversation-client";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

export interface TaskConversationScope {
  workspaceKey: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface TaskConversationPorts {
  prepare(): Promise<void>;
  open(): Promise<ConversationTransport>;
  onState(state: ConversationStoreState): void;
  onError(error: unknown): void;
}

/** 手机对既有 V4 projection 的生命周期适配；投影事实始终由 SessionDataLayer 持有。 */
export class TaskConversationLifecycle {
  private generation = 0;
  private disposed = false;
  private layer: SessionDataLayer | null = null;
  private lease: SessionLease | null = null;
  private transportValue: ConversationTransport | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private displayedState: ConversationStoreState | null = null;
  private displayedSnapshot: ConversationSnapshot | null = null;
  private reportedStoreError: string | null = null;

  constructor(
    private readonly scope: TaskConversationScope,
    private readonly ports: TaskConversationPorts,
  ) {}

  get store(): SessionLease["store"] | null {
    return this.lease?.store ?? null;
  }

  get transport(): ConversationTransport | null {
    return this.transportValue;
  }

  get ready(): boolean {
    const state = this.store?.getState();
    return state?.status === "live" && state.snapshot !== null;
  }

  start(): void {
    this.begin(false);
  }

  /** bridge generation 失效后重开同一 scope，显示旧内容直到新权威 snapshot 到达。 */
  recoverBridge(): void {
    this.begin(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.releaseProjection();
  }

  private begin(preserveDisplayedSnapshot: boolean): void {
    if (this.disposed) return;
    const generation = ++this.generation;
    const currentState = this.store?.getState() ?? this.displayedState;
    if (preserveDisplayedSnapshot) {
      if (currentState?.snapshot) this.displayedSnapshot = currentState.snapshot;
      if (currentState) {
        // 旧 snapshot 仅供 React 暂时显示；不传给新 layer 作为 resume base。
        this.displayedState = {
          ...currentState,
          status: "connecting",
          subscriptionId: null,
          snapshot: this.displayedSnapshot,
        };
        this.ports.onState(this.displayedState);
      }
    } else {
      this.displayedSnapshot = null;
      this.displayedState = null;
    }
    this.releaseProjection();
    void this.openProjection(generation);
  }

  private async openProjection(generation: number): Promise<void> {
    try {
      await this.ports.prepare();
      if (!this.current(generation)) return;
      const transport = await this.ports.open();
      if (!this.current(generation)) return;

      const layer = new SessionDataLayer({ transport });
      const lease = layer.acquire(this.scope.taskId);
      if (!this.current(generation)) {
        lease.release();
        layer.dispose();
        return;
      }

      this.transportValue = transport;
      this.layer = layer;
      this.lease = lease;
      this.unsubscribeStore = lease.store.subscribe(() => {
        if (this.current(generation)) this.publishStoreState(lease.store.getState());
      });
      // acquire() starts connect immediately; subscribe first, then publish its current state.
      this.publishStoreState(lease.store.getState());
    } catch (error) {
      if (!this.current(generation)) return;
      const message = error instanceof Error ? error.message : String(error);
      const currentState = this.store?.getState() ?? this.displayedState;
      if (currentState) {
        this.displayedState = {
          ...currentState,
          status: "error",
          subscriptionId: null,
          lastError: message,
          snapshot: currentState.snapshot ?? this.displayedSnapshot,
        };
        this.ports.onState(this.displayedState);
      }
      this.ports.onError(error);
    }
  }

  private publishStoreState(state: ConversationStoreState): void {
    if (state.snapshot) this.displayedSnapshot = state.snapshot;
    if (state.status === "error" && state.lastError) {
      if (this.reportedStoreError !== state.lastError) {
        this.reportedStoreError = state.lastError;
        this.ports.onError(new Error(state.lastError));
      }
    } else {
      this.reportedStoreError = null;
    }
    // ACK 可先把 store 标为 live。手机需等权威首帧；恢复时旧 snapshot 只用于显示。
    const waitingForSnapshot = state.status === "live" && state.snapshot === null;
    this.displayedState = waitingForSnapshot
      ? {
          ...state,
          status: "connecting",
          subscriptionId: null,
          snapshot: this.displayedSnapshot,
        }
      : state.snapshot === null && this.displayedSnapshot !== null
        ? { ...state, snapshot: this.displayedSnapshot }
        : state;
    this.ports.onState(this.displayedState);
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private releaseProjection(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.lease?.release();
    this.lease = null;
    this.layer?.dispose();
    this.layer = null;
    this.transportValue = null;
  }
}
