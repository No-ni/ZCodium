/** 仅保存既有去重窗口的 FIFO 顺序；成员事实仍由调用方的 Set/Map 拥有。 */
export class BoundedEventIdOrder {
  private entries: string[] = [];
  private nextIndex = 0;

  constructor(private readonly capacity: number) {}

  push(eventId: string): string | undefined {
    if (this.entries.length < this.capacity) {
      this.entries.push(eventId);
      return undefined;
    }
    // 满窗后每个流式事件 shift 都会重排顺序数组；环形覆盖保留原 FIFO 淘汰规则。
    const removed = this.entries[this.nextIndex];
    this.entries[this.nextIndex] = eventId;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    return removed;
  }

  removeWhere(predicate: (eventId: string) => boolean): string[] {
    const retained: string[] = [];
    const removed: string[] = [];
    for (let offset = 0; offset < this.entries.length; offset += 1) {
      const eventId = this.entries[(this.nextIndex + offset) % this.entries.length]!;
      (predicate(eventId) ? removed : retained).push(eventId);
    }
    this.entries = retained;
    this.nextIndex = 0;
    return removed;
  }

  clear(): void {
    this.entries.length = 0;
    this.nextIndex = 0;
  }
}
