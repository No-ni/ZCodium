// subscribe ACK activation barrier：notification 可能先于 RPC response 抵达 renderer。
// transport 先按 topic 有界暂存，store 写入 ACK subscriptionId 后显式 activate；
// 这里只暂存 physical wire；logical assembly 在 ownership 激活后执行。
interface PendingFrameSubscription<T> {
  topic: string;
  subscriptionId: string | null;
  frames: T[];
  stagedBytes: number;
  overflowReason: string | null;
}

const MAX_STAGED_FRAMES = 1024;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;
const STAGING_OVERFLOW_REASON = "fault.subscription.initialFrameStagingOverflow";

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

interface AckActivationBarrier<T extends { topic: string; subscriptionId: string }> {
  begin(topic: string): object;
  bind(token: object, subscriptionId: string): void;
  cancel(token: object): void;
  activate(
    subscriptionId: string,
  ): { topic: string; previousSubscriptionId: string | null } | undefined;
  forget(subscriptionId: string): void;
  accept(frame: T): void;
  /** runtime/attachment generation invalidation：丢弃全部 active/pending ownership。 */
  clear(): void;
}

/** transport-local physical-wire barrier；同 topic 并发 pending 各自等 ACK 决定 owner。 */
export function createAckActivationBarrier<T extends { topic: string; subscriptionId: string }>(
  deliver: (frame: T) => void,
): AckActivationBarrier<T> {
  const pendingByTopic = new Map<string, Set<PendingFrameSubscription<T>>>();
  const pendingBySubscriptionId = new Map<string, PendingFrameSubscription<T>>();
  const activeByTopic = new Map<string, string>();
  const topicByActiveSubscription = new Map<string, string>();

  const removePending = (pending: PendingFrameSubscription<T>): void => {
    const group = pendingByTopic.get(pending.topic);
    group?.delete(pending);
    if (group?.size === 0) pendingByTopic.delete(pending.topic);
    if (pending.subscriptionId) {
      pendingBySubscriptionId.delete(pending.subscriptionId);
    }
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };

  return {
    begin(topic) {
      const pending: PendingFrameSubscription<T> = {
        topic,
        subscriptionId: null,
        frames: [],
        stagedBytes: 0,
        overflowReason: null,
      };
      const group = pendingByTopic.get(topic) ?? new Set();
      group.add(pending);
      pendingByTopic.set(topic, group);
      return pending;
    },
    bind(token, subscriptionId) {
      const pending = token as PendingFrameSubscription<T>;
      if (pending.overflowReason) {
        const reason = pending.overflowReason;
        removePending(pending);
        throw new Error(reason);
      }
      pending.subscriptionId = subscriptionId;
      pendingBySubscriptionId.set(subscriptionId, pending);
    },
    cancel(token) {
      removePending(token as PendingFrameSubscription<T>);
    },
    activate(subscriptionId) {
      const pending = pendingBySubscriptionId.get(subscriptionId);
      if (!pending) return;
      const previous = activeByTopic.get(pending.topic);
      if (previous && previous !== subscriptionId) {
        topicByActiveSubscription.delete(previous);
      }
      activeByTopic.set(pending.topic, subscriptionId);
      topicByActiveSubscription.set(subscriptionId, pending.topic);
      const frames = pending.frames.filter((frame) => frame.subscriptionId === subscriptionId);
      removePending(pending);
      for (const frame of frames) deliver(frame);
      return {
        topic: pending.topic,
        previousSubscriptionId: previous ?? null,
      };
    },
    forget(subscriptionId) {
      const pending = pendingBySubscriptionId.get(subscriptionId);
      if (pending) removePending(pending);
      const topic = topicByActiveSubscription.get(subscriptionId);
      if (topic && activeByTopic.get(topic) === subscriptionId) {
        activeByTopic.delete(topic);
      }
      topicByActiveSubscription.delete(subscriptionId);
    },
    accept(frame) {
      if (activeByTopic.get(frame.topic) === frame.subscriptionId) {
        deliver(frame);
        return;
      }
      const group = pendingByTopic.get(frame.topic);
      if (!group) return;
      let encodedFrameBytes: number | undefined;
      for (const pending of group) {
        if (pending.overflowReason) continue;
        // 已失败或帧数已满的暂存必然丢弃；先判上限，避免继续为大消息分配 JSON/UTF-8。
        // 同 topic 的多个健康 pending 仍共享一次字节计量，各自保留原容量边界。
        const frameLimitExceeded = pending.frames.length + 1 > MAX_STAGED_FRAMES;
        const bytes = frameLimitExceeded ? 0 : (encodedFrameBytes ??= encodedBytes(frame));
        if (
          frameLimitExceeded ||
          bytes > MAX_STAGED_BYTES ||
          pending.stagedBytes + bytes > MAX_STAGED_BYTES
        ) {
          // 通过 shift 头部来“维持上限”会留下一个看似可激活、
          // 实际缺片的 physical batch。越界必须整批清空并让 subscribe 明确失败。
          pending.frames.length = 0;
          pending.stagedBytes = 0;
          pending.overflowReason = STAGING_OVERFLOW_REASON;
          continue;
        }
        pending.frames.push(frame);
        pending.stagedBytes += bytes;
      }
    },
    clear() {
      for (const group of pendingByTopic.values()) {
        for (const pending of group) {
          pending.frames.length = 0;
          pending.stagedBytes = 0;
        }
      }
      pendingByTopic.clear();
      pendingBySubscriptionId.clear();
      activeByTopic.clear();
      topicByActiveSubscription.clear();
    },
  };
}
