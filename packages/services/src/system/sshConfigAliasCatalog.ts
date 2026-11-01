/**
 * SSH config alias 列表的 TTL 快照 + 在途单飞目录。
 *
 * 从 sshConfigAlias.ts 抽出的缓存簿记：原实现只有一个 30s TTL 的模块级结果缓存，
 * 且只能在一次扫描完成后阻挡顺序重复；并发首调会各自完整重扫并重复 spawn ssh -G。
 * 本 helper 是纯 DI（loader + 时钟 + TTL + 拷贝），自身不做 IO、不直连时钟，
 * 默认装配见 sshConfigAlias.ts 的模块级 catalog。
 *
 * 不变量（与 docs/specs/ssh-config-alias-single-flight.md 一致）：
 * - TTL 锚定在调用开始：read() 入口捕获 now，快照 expiresAt = 开始时刻 + ttlMs（非完成时刻）；
 * - 过期比较严格 expiresAt > now；
 * - 每次返回都经过 clone，调用方不得共享或污染缓存条目；
 * - 在途单飞：TTL miss 且扫描在途时后来者 join 同一 flight，不发起第二次扫描；
 *   TTL 过期不取消在途扫描，加入者只获得该次在途快照的副本（不保证实时文件快照）；
 * - 拒绝语义：flight 内所有等待方收到同一拒绝，finally 清除 flight，不吞异常、
 *   不缓存拒绝，下一次 read() 重新扫描；
 * - 慢扫描超过 ttlMs 时快照落入即过期，下一次 read() 重新扫描。
 */

interface SshConfigAliasCatalogOptions<T> {
  /** 完整扫描 loader：每次真实扫描（配置解析 + ssh -G/fallback）的唯一入口。 */
  readonly load: () => Promise<T>;
  /** 时钟源：read() 入口捕获，用于 TTL 锚定与过期比较。 */
  readonly now: () => number;
  /** 快照 TTL（ms）：expiresAt = 调用开始时刻 + ttlMs。 */
  readonly ttlMs: number;
  /** 返回前拷贝：leader 与加入者都获得独立副本。 */
  readonly clone: (value: T) => T;
}

interface SshConfigAliasCatalog<T> {
  read(): Promise<T>;
}

export function createSshConfigAliasCatalog<T>(
  options: SshConfigAliasCatalogOptions<T>,
): SshConfigAliasCatalog<T> {
  let snapshot: { expiresAt: number; value: T } | null = null;
  let flight: Promise<T> | null = null;

  return {
    async read() {
      const now = options.now();
      if (snapshot && snapshot.expiresAt > now) {
        return options.clone(snapshot.value);
      }
      if (flight) {
        // 在途扫描的加入者共享同一 flight；TTL 过期不取消在途扫描，
        // 加入者只获得该次在途快照的独立副本。
        return options.clone(await flight);
      }

      // startedAt 用 read() 入口捕获的 now：expiresAt 锚定调用开始，
      // 慢扫描超过 ttlMs 时快照落入即过期，不按完成时刻续期。
      const startedAt = now;
      const current = options.load();
      flight = current;
      try {
        const value = await current;
        snapshot = { expiresAt: startedAt + options.ttlMs, value };
        return options.clone(value);
      } finally {
        // 成功与拒绝都清除 flight：拒绝不缓存、不吞异常，下一次 read() 重新扫描。
        if (flight === current) {
          flight = null;
        }
      }
    },
  };
}
