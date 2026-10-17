/** RPC 内部 FIFO；已消费槽位立即释放，仅在废弃前缀足够大时摊销整理。 */
export class FifoQueue<T> {
  private entries: Array<T | undefined> = [];
  private head = 0;

  get length(): number {
    return this.entries.length - this.head;
  }

  push(value: T): void {
    this.entries.push(value);
  }

  at(index: number): T | undefined {
    return index >= 0 && index < this.length ? this.entries[this.head + index] : undefined;
  }

  peek(): T | undefined {
    return this.at(0);
  }

  shift(): T | undefined {
    if (this.length === 0) return undefined;
    const value = this.entries[this.head];
    // 只推进游标仍会强持有已确认帧/已读块；必须先解除对象引用，再考虑整理背板。
    this.entries[this.head++] = undefined;
    if (this.head === this.entries.length) {
      this.clear();
    } else if (this.head >= 1024 && this.head * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
    return value;
  }

  /** 仅用于明确需要完整遍历的重放；消费路径不创建队列快照。 */
  toArray(): T[] {
    return this.entries.slice(this.head) as T[];
  }

  clear(): void {
    this.entries = [];
    this.head = 0;
  }
}
