import type { ZCodeMessageWithParts, ZCodeStreamEvent } from "@zcode/shared";
import {
  conversationMessagesFromSnapshot,
  type ConversationAction,
  type ConversationScope,
} from "./conversationReducer.js";
import type { TaskStreamSubscription } from "./protocol.js";

interface TaskConversationPorts {
  subscribe(onEvent: (event: ZCodeStreamEvent) => void): Promise<TaskStreamSubscription>;
  read(): Promise<ZCodeMessageWithParts[]>;
  dispatch(action: ConversationAction): void;
  onError(error: unknown): void;
}

/** 单一订阅/快照时序所有者；React 只创建/销毁并渲染 reducer 投影。 */
export class TaskConversationLifecycle {
  private generation = 0;
  private eventVersion = 0;
  private awaitingSnapshot = true;
  private readingGeneration: number | null = null;
  private subscription: TaskStreamSubscription | null = null;
  private subscribed = false;
  private disposed = false;

  constructor(
    private readonly scope: ConversationScope,
    private readonly ports: TaskConversationPorts,
  ) {}

  start(): void {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.subscription?.dispose();
    this.subscription = null;
    this.subscribed = false;
    this.awaitingSnapshot = true;
    this.eventVersion += 1;
    this.ports.dispatch({ type: "beginScope", scope: this.scope });
    void this.subscribe(generation);
  }

  /** 协议层已作废桥/accessor 后，再重开、重订、读快照；不能只改 reducer flags。 */
  recoverBridge(): void {
    this.start();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.subscription?.dispose();
    this.subscription = null;
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private async subscribe(generation: number): Promise<void> {
    try {
      const subscription = await this.ports.subscribe((event) => {
        if (!this.current(generation)) return;
        this.accept(event, generation);
      });
      if (!this.current(generation)) {
        subscription.dispose();
        return;
      }
      this.subscription = subscription;
      this.subscribed = true;
      this.readSnapshot(generation);
    } catch (error) {
      if (this.current(generation)) this.ports.onError(error);
    }
  }

  private accept(event: ZCodeStreamEvent, generation: number): void {
    if (event.taskId !== this.scope.taskId) return;
    const resync =
      event.type === "task_snapshot_updated" ||
      event.type === "task_complete" ||
      event.type === "task_error";
    if (resync || event.type === "agent_message_chunk") this.eventVersion += 1;
    if (resync) this.awaitingSnapshot = true;
    this.ports.dispatch({ type: "streamEvent", scope: this.scope, event });
    if (this.awaitingSnapshot && this.subscribed) this.readSnapshot(generation);
  }

  private readSnapshot(generation: number): void {
    if (this.readingGeneration === generation) return;
    this.readingGeneration = generation;
    void this.readUntilStable(generation);
  }

  private async readUntilStable(generation: number): Promise<void> {
    try {
      while (this.current(generation) && this.awaitingSnapshot) {
        const version = this.eventVersion;
        const messages = await this.ports.read();
        if (!this.current(generation)) return;
        // R 在途时 delta/终态/快照更新已发生，旧 R 不能清掉更晚屏障。
        // 没有 sequence 水位不能拼接缓存 delta；必须权威补读，直到读取期间版本未变。
        if (version !== this.eventVersion) continue;
        this.awaitingSnapshot = false;
        this.ports.dispatch({
          type: "applySnapshot",
          scope: this.scope,
          messages: conversationMessagesFromSnapshot(messages),
        });
      }
    } catch (error) {
      if (this.current(generation)) this.ports.onError(error);
    } finally {
      if (this.readingGeneration === generation) this.readingGeneration = null;
    }
  }
}
