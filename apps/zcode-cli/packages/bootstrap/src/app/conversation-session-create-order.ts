// 根因：mkdir 与 record 登记之间有异步装配，两个显式 ID 可同时占用同一个短目录名。
// 所有权仅属于该 app-server；持有到 record 已登记，失败不阻断后续，空队列立即回收。
const creationTails = new WeakMap<object, Promise<unknown>>();

export async function runConversationSessionCreation<T>(
  owner: object,
  create: () => Promise<T>,
): Promise<T> {
  const previous = creationTails.get(owner);
  const current = (previous ? previous.catch(() => {}) : Promise.resolve()).then(create);
  creationTails.set(owner, current);
  try {
    return await current;
  } finally {
    if (creationTails.get(owner) === current) creationTails.delete(owner);
  }
}
