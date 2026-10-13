import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 对话会话目录的**观测与比对面**：从会话库读出「哪些执行目录仍在册」，并回答
 * 「这个执行目录还是不是别的会话在用」。回收动作（`rmdir` / 清扫）在
 * `conversation-session-workspace-reclaim.ts`；本模块只判定、不删除、不建目录。
 *
 * 从回收模块拆出来只为一条机械约束：回收模块的有效行数已过 CLI 的 400 行 lint 上限，
 * 而这一组符号职责自洽（「库里谁在用这个目录」），与破坏性动作分属两件事。
 *
 * 为什么删除与清扫都必须查库：注册表与年龄都只是**本进程**能看见的事实。同一个对话工作区
 * 可以在两个窗口（各自一个 window-scoped Local Host）里打开，A 窗口 fork 出的子会话继承父会话
 * 执行 cwd 并把行落进共享 sqlite；B 窗口删父会话时注册表里没有那条子会话，只按进程内事实
 * 判定就会 rmdir 掉 A 窗口仍存活子会话的正空目录，它下一次相对写入即 ENOENT。
 * 见 docs/specs/conversation-session-workspace.md 规则 8。
 */

/**
 * 清扫/复检要用的会话库窄面：**只取「哪些执行目录仍在册」这一个事实**。
 *
 * 不 import adapters 的具体类：实现是 `SqliteSessionStore.listSessions`，但这里只需要
 * 「能列出会话行的 id + path」，结构与它一致即可（`SessionInfo[]` 天然满足），
 * 这样端口能在测试里用假实现替换，也不把 bootstrap 绑死在某个存储实现上。
 */
export interface ConversationSessionPathSource {
  listSessions(input: {
    includeArchived: boolean;
  }): Promise<Array<{ id?: string | null; path?: string | null }>>;
}

/** 会话行里本模块用到的两个字段：`id` 用于排除「正在被关的这一行」，`path` 是在册执行目录。 */
export type ConversationSessionPathRow = { id?: string | null; path?: string | null };

/** 进程内注册表 record 在本模块用到的最小视图：执行 cwd。与回收模块共用这一份形状定义。 */
export type ConversationSessionRecordLike = { executionWorkspacePath?: string | undefined };

/**
 * 读一次全表 `path` 行；**拿不到事实返回 `undefined`**（查库抛错 / 返回值不是行数组）。
 *
 * 「返回值不是可迭代的行集合」必须与抛错同解：过去写成 `rows ?? []`，契约外的返回会被当成
 * **空的在册集合**，清扫随后按年龄删掉别的进程仍在使用的空目录，而日志里看起来一切正常
 * ——守卫静默失效正是回收模块要消灭的分支。破坏性操作拿不到事实就不动手（fail-closed）。
 */
export async function readConversationSessionPathRows(
  source: ConversationSessionPathSource,
): Promise<ConversationSessionPathRow[] | undefined> {
  let rows: unknown;
  try {
    rows = await source.listSessions({ includeArchived: true });
  } catch {
    return undefined;
  }
  return Array.isArray(rows) ? (rows as ConversationSessionPathRow[]) : undefined;
}

/**
 * 收集「仍在册」的执行目录（= 会话库里有非空 `path` 的行），规范化后进 Set。
 *
 * **刻意不用 `directory` 过滤**：`ListSessionsInput.directory` 是精确字符串相等匹配，而查询键只
 * 能来自 spawn 注入的 `ZCODE_CONVERSATION_WORKSPACE_ROOT`，它与库里的工作区键路径可能只是形态
 * 不同（尾分隔符、符号链接、大小写）。一旦不相等，过滤查询会**静默返回 0 行**，在册集合为空，
 * 清扫就退回「只按年龄删」——守卫静默失效且没有任何报错。破坏性操作里的守卫不能有沉默的 no-op
 * 分支，因此取全表 `path`：命中判定交给清扫侧（目录形状 + 包含关系）保证，代价是启动时一次查询。
 *
 * 返回 `undefined` = 拿不到事实。调用方必须**放弃整个清扫**：破坏性操作拿不到事实就不动手。
 */
export async function readRegisteredConversationSessionDirs(
  source: ConversationSessionPathSource,
): Promise<Set<string> | undefined> {
  const rows = await readConversationSessionPathRows(source);
  if (!rows) {
    return undefined;
  }
  const directories = new Set<string>();
  const paths: string[] = [];
  for (const row of rows) {
    const path = row?.path?.trim();
    if (path) {
      paths.push(resolve(path));
    }
  }
  // 逐条算 key：`realpath` 是 IO，但只在启动时一次（fire-and-forget），量级是会话行数。
  for (const path of paths) {
    directories.add(await conversationSessionDirectoryKey(path));
  }
  return directories;
}

/**
 * 「同一个执行目录」的比较 key：`realpath` 优先、失败回落 `resolve`，再按平台折叠大小写
 * （win32 / darwin 的默认文件系统大小写不敏感，Linux 大小写敏感，不能折叠）。
 *
 * 为什么不能用 `resolve` 后的字符串直接比：库里行的 `path` 与清扫侧拼出的候选路径只要
 * 形态不同（符号链接形态如 `/var` vs `/private/var`、盘符或目录名大小写），字符串相等就判否，
 * 于是「另一个进程仍在用的空目录」被当成陈旧目录删掉——正是本守卫要防的场景。
 * 折叠是保守方向：判成"在册"只会少删，不会多删。
 */
export async function conversationSessionDirectoryKey(directory: string): Promise<string> {
  const resolved = resolve(directory);
  const canonical = await realpath(resolved).catch(() => resolved);
  return foldConversationSessionDirectoryCase(canonical);
}

/**
 * 执行目录比较的大小写规则：win32 / darwin 的默认文件系统大小写不敏感（同一目录可能以不同
 * 大小写形态出现），Linux 大小写敏感（不能折叠，否则会把两个真实不同的目录判成同一个）。
 *
 * 删/留两个方向都必须用同一份规则：清扫的在册命中（`conversationSessionDirectoryKey`）与
 * 删除边界的「目录仍被别的会话使用」（`isConversationSessionDirectoryInUse`）判据不一致时，
 * 只有破坏性的一方会漏判。本函数保持同步（无 IO），清扫侧在它之上另加 `realpath`。
 */
export function foldConversationSessionDirectoryCase(value: string): string {
  return process.platform === "linux" ? value : value.toLowerCase();
}

/**
 * 该执行目录是否还被**本进程注册表**里的别的会话使用。
 *
 * 派生会话（fork / 侧会话 / 继承父 cwd 的 workflow 子会话）的目录名来自父会话 id，因此删除
 * 父会话时「名字归本会话所有」无法发现目录**仍被存活的子会话使用**。不查这一遍就会 rmdir 掉
 * 子会话正在用的空目录，它下一次按相对路径写文件即 ENOENT。按注册表里的执行 cwd 逐条比对
 * （规范化后比较，避免尾分隔符/相对写法漏判）。
 *
 * 大小写折叠与库侧**同一条规则**（`foldConversationSessionDirectoryCase`）：判据方向是
 * 「保守 = 保留」，多判只会少删一个空目录，漏判会拆掉存活子会话的工作目录。
 * 本函数无 IO（不查 realpath），保持同步以便删除边界直接调用。
 */
export function isConversationSessionDirectoryInUse(input: {
  sessions: Iterable<ConversationSessionRecordLike>;
  executionPath: string | undefined;
}): boolean {
  const executionPath = input.executionPath?.trim();
  if (!executionPath) {
    return false;
  }
  const target = foldConversationSessionDirectoryCase(resolve(executionPath));
  for (const session of input.sessions) {
    const candidate = session.executionWorkspacePath?.trim();
    if (candidate && foldConversationSessionDirectoryCase(resolve(candidate)) === target) {
      return true;
    }
  }
  return false;
}

/**
 * 删除边界的**跨进程**复检：进程内注册表 + 会话库里是否还有**别的**会话把同一个目录当执行 cwd。
 *
 * 为什么注册表不够：注册表只是本进程能看见的事实（模块头）。清扫侧早已因为同一条理由
 * （年龄只是本进程能看见的事实）改成查库守卫，删除侧不能比它弱。
 *
 * 三个方向都取「保守 = 保留」：
 * - 本进程注册表命中 ⇒ true（`isConversationSessionDirectoryInUse`）；
 * - 拿不到事实（没给端口 / 查库抛错 / 返回值不是行数组）⇒ true，宁可不回收空目录；
 * - 库里命中**别的**会话 ⇒ true。
 *
 * 被关会话自己的行必须排除：v4 `deleteSession` 的语义是关闭而不是真删 record，行仍在库里
 * （`bootstrap/zcode-protocol-v4/commands/handlers/session-mgmt.ts`），不排除就永远回收不了。
 *
 * 比较用「折叠大小写后的 resolved 形态」做廉价预筛；预筛未命中时**懒算该行自己的规范 key**
 * （`realpath` 归一，与清扫侧收在册集合同源）再比对——预筛 miss 既可能来自行侧拼写，也可能
 * 来自目标侧（两侧只要有一边经过符号链接，`realpath` 就与 `resolve` 不同），不能只看目标侧
 * 决定要不要做行侧 realpath：目标拼写规范、而行是链接形态（`/var` vs `/private/var`）时，
 * 纯词法比较全 miss 且 realpath 分支被短路 ⇒ 判「不在册」⇒ rmdir 掉别的进程仍在用的空目录，
 * 删除侧比清扫弱（清扫对每行都 realpath）。正常路径下（词法命中或确实无关）预筛即收口，
 * 每次删除仍只多一次 `listSessions`；逐行懒 realpath 的最坏代价与清扫侧同阶。
 */
export async function isConversationSessionDirectoryInUseAcrossProcesses(input: {
  executionPath: string | undefined;
  registrySessions: Iterable<ConversationSessionRecordLike>;
  sessionPathSource: ConversationSessionPathSource | undefined;
  /** 正在被关的会话 id（它的行会留在库里，必须排除）。 */
  excludeSessionId: string;
}): Promise<boolean> {
  if (
    isConversationSessionDirectoryInUse({
      executionPath: input.executionPath,
      sessions: input.registrySessions,
    })
  ) {
    return true;
  }
  const executionPath = input.executionPath?.trim();
  if (!executionPath) {
    return false;
  }
  const source = input.sessionPathSource;
  if (!source) {
    return true;
  }
  const rows = await readConversationSessionPathRows(source);
  if (!rows) {
    return true;
  }
  const excludeSessionId = input.excludeSessionId.trim();
  const resolvedTarget = foldConversationSessionDirectoryCase(resolve(executionPath));
  const canonicalTarget = await conversationSessionDirectoryKey(executionPath);
  for (const row of rows) {
    const path = row?.path?.trim();
    if (!path) {
      continue;
    }
    if (excludeSessionId.length > 0 && row?.id?.trim() === excludeSessionId) {
      continue;
    }
    const resolved = foldConversationSessionDirectoryCase(resolve(path));
    if (resolved === resolvedTarget || resolved === canonicalTarget) {
      return true;
    }
    // 预筛未命中也可能因为**行侧**经过符号链接（不能只看目标侧决定要不要 realpath）。
    if ((await conversationSessionDirectoryKey(path)) === canonicalTarget) {
      return true;
    }
  }
  return false;
}
