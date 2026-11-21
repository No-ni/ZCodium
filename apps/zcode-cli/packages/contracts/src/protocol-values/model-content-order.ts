/**
 * blockIndex 是否合法（非负整数）。库、runtime、请求投影判定"有序"都用它，三层结论才一致。
 * 见 apps/zcode-cli/docs/design/v2/model/assistant-block-order.md。
 */
export function isBlockIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/**
 * 每一项的序号都合法（isBlockIndex）时，返回按序号稳定排序的新数组；
 * 有任何一项缺失或非法时返回 undefined，由调用方决定退回哪种顺序。
 */
export function sortByCompleteIndex<T>(
  items: readonly T[],
  indexOf: (item: T) => unknown,
): T[] | undefined {
  if (!items.every((item) => isBlockIndex(indexOf(item)))) return undefined;
  return [...items].sort((left, right) => (indexOf(left) as number) - (indexOf(right) as number));
}
