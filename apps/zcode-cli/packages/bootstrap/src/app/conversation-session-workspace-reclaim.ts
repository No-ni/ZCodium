import { lstat, readdir, rmdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Logger } from "@zcode/contracts";
import {
  CONVERSATION_SESSION_DATE_DIR_PATTERN,
  CONVERSATION_SESSION_DIR_NAME_FALLBACK_LENGTH,
  CONVERSATION_SESSION_DIR_NAME_LENGTH,
  CONVERSATION_SESSION_DIR_NAME_PATTERN,
  buildConversationSessionDirName,
  isConversationSessionWorkspacePath,
  resolveConversationWorkspaceRootFromEnv,
} from "./conversation-session-workspace.js";
import {
  conversationSessionDirectoryKey,
  readRegisteredConversationSessionDirs,
  type ConversationSessionPathSource,
} from "./conversation-session-workspace-registry.js";

/**
 * 会话目录的空目录回收（**破坏性动作**的一侧）。
 *
 * 只回收**空**目录：会话被删除时顺手清掉它自己的空目录，Host 启动时清扫 7 天前的空目录。
 * 任何含文件的会话目录都不自动删除——会话目录里可能有用户未提交的产物，只有「一次都没
 * 用过」的草稿目录才允许消失。回收范围严格限制在 `<对话根>/<YYYY-MM-DD>/<会话目录>`，
 * 根下的其他文件与目录一律不碰。见 docs/specs/conversation-session-workspace.md 规则 8。
 *
 * 草稿会话（deferred 持久化）在被删除时 sqlite 里还没有行，「这个会话的执行 cwd 是哪个目录」
 * 只在内存 record 上（`executionWorkspacePath`）。因此删除边界的回收读 record，不读会话库；
 * 而「进程崩溃后残留的草稿目录」没有删除边界可依附，只能靠启动清扫的 7 天年龄兜底。
 *
 * 「库里谁在用这个目录」（跨进程观测与比较）在 `conversation-session-workspace-registry.ts`：
 * 年龄与注册表都只是本进程能看见的事实，另一个 app-server 里 7 天前激活、之后一直开着的
 * 空目录会话（只做问答、没写过文件，mtime 停在被激活那一刻）在年龄上完全像残留，扫掉它，
 * 那个进程下一次相对写入就是 ENOENT；删除边界同理（A 窗口仍跑着子会话时被 B 窗口删掉
 * 它的工作目录）。因此清扫与删除都拿库做守卫，拿不到就放弃（fail-closed）。
 */

/** 启动清扫只处理超过该年龄的空目录，避免误删正在预热、尚未写入的草稿目录。 */
export const CONVERSATION_SESSION_EMPTY_SWEEP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// 观测与比面对面（registry 模块）保持从本模块可达：本模块的有效行数已过 CLI 的 400 行
// lint 上限，而「库里谁在用这个目录」与「删一个空目录」分属两件事。原 import 路径
// （server-operations / v4-bridge / CI 测试）不需要改动。
export {
  conversationSessionDirectoryKey,
  foldConversationSessionDirectoryCase,
  isConversationSessionDirectoryInUse,
  isConversationSessionDirectoryInUseAcrossProcesses,
  readConversationSessionPathRows,
  readRegisteredConversationSessionDirs,
  type ConversationSessionPathRow,
  type ConversationSessionPathSource,
  type ConversationSessionRecordLike,
} from "./conversation-session-workspace-registry.js";

/** 回收的日志面：命中回收是 debug，异常是不可阻断删除的 warn，不额外打扰 info。 */
type ConversationSessionReclaimLogger = Pick<Logger, "debug" | "warn">;

/**
 * 该会话是否属于「本进程启用独立目录规则」的对话根工作区。
 *
 * 用 `workspaceKey`（身份键 = workspaceIdentity ?? workspacePath）判定，而不是 `workspacePath`：
 * 按 spec，对话工作区的身份键必须恒为对话根，而 `workspacePath` 与执行 cwd 是两个概念，
 * 未来任何一侧措辞变化都不该让回收跟着漂。带 identity 或 remoteSessionId 的 workspace
 * （远程 pane、手机远端的远端 workspace）一律不回收。
 */
export function isConversationSessionReclaimEnabled(input: {
  conversationRoot: string | undefined;
  workspaceKey: string | undefined;
  workspaceIdentity?: string | undefined;
  remoteSessionId?: string | undefined;
}): boolean {
  const conversationRoot = input.conversationRoot?.trim();
  const workspaceKey = input.workspaceKey?.trim();
  if (!conversationRoot || !workspaceKey) {
    return false;
  }
  if (input.workspaceIdentity?.trim() || input.remoteSessionId?.trim()) {
    return false;
  }
  return resolve(workspaceKey) === resolve(conversationRoot);
}

/**
 * 目录是否归该会话所有：目录名必须由该会话 id 派生（8 位，碰撞时 12 位）。
 *
 * 派生的侧会话与 fork 继承父会话的执行 cwd（spec 规则 5），它们的目录名来自**父会话** id；
 * 删一个侧会话不能顺手删掉父会话仍在使用的目录。名字规则是创建边界的同一份事实
 * （conversation-session-workspace.ts），这里只做等值确认，不从名字反推日期或路径。
 */
export function ownsConversationSessionDirectory(input: {
  sessionId: string;
  executionPath: string;
}): boolean {
  const name = basename(resolve(input.executionPath));
  return (
    name ===
      buildConversationSessionDirName(input.sessionId, CONVERSATION_SESSION_DIR_NAME_LENGTH) ||
    name ===
      buildConversationSessionDirName(
        input.sessionId,
        CONVERSATION_SESSION_DIR_NAME_FALLBACK_LENGTH,
      )
  );
}

/**
 * 删除会话时是否应回收它的空目录。纯判定，五个条件同时成立才回收：
 * 进程启用了对话根规则（`enabled`）、执行 cwd 不为空、它**严格落在**对话根之下
 * （等于对话根是存量会话的旧值，不回收）、**形状恰好是布局本身**
 * （`<对话根>/<YYYY-MM-DD>/<名字>`，见下）、目录名由该会话自己派生（所有权）。
 *
 * 形状判定是破坏性路径的保守边界：只按「严格在根下 + 名字由 id 派生」判，会连
 * `<根>/<任意中间目录>/<日期>/<名字>` 这种本规则从不产生的路径也一起删（并顺手删掉那个日期目录）。
 * 深度与父目录名都必须与创建侧一致，无法归因的路径一律不碰。
 */
export function shouldReclaimConversationSessionDir(input: {
  conversationRoot: string | undefined;
  executionPath: string | undefined;
  enabled: boolean;
  sessionId: string;
}): boolean {
  if (!input.enabled) {
    return false;
  }
  const conversationRoot = input.conversationRoot?.trim();
  const executionPath = input.executionPath?.trim();
  if (!conversationRoot || !executionPath) {
    return false;
  }
  const resolvedRoot = resolve(conversationRoot);
  const resolvedPath = resolve(executionPath);
  // 保护性复检（破坏性操作不接受「同一根」的近似判定）：`path.relative` 在 Windows 跨盘符时
  // 返回绝对路径，而共享的 `isConversationSessionWorkspacePath` 只按首段是否为 `..` 判定，
  // 会把另一个盘符上的同名目录当成会话目录。两个根不同一律不回收。
  if (isAbsolute(relative(resolvedRoot, resolvedPath))) {
    return false;
  }
  if (
    !isConversationSessionWorkspacePath(executionPath, conversationRoot) ||
    !ownsConversationSessionDirectory({ executionPath, sessionId: input.sessionId })
  ) {
    return false;
  }
  const dateDir = resolve(join(resolvedPath, ".."));
  return (
    resolve(join(dateDir, "..")) === resolvedRoot &&
    CONVERSATION_SESSION_DATE_DIR_PATTERN.test(basename(dateDir))
  );
}

export interface ConversationSessionReclaimInput {
  /** 进程注入的对话根标记；未注入即不适用本规则。 */
  conversationRoot: string | undefined;
  /** 会话所属 workspace 的身份键（`record.workspace.workspaceKey`）。 */
  workspaceKey: string | undefined;
  workspaceIdentity?: string | undefined;
  remoteSessionId?: string | undefined;
  sessionId: string;
  /** 会话执行 cwd（内存 record 事实；草稿会话没有持久化行）。 */
  executionPath: string | undefined;
  /**
   * 同一执行目录是否仍被别的在册会话使用（fork / 侧会话继承父会话 cwd）。调用方在把被删会话
   * 从注册表摘除**之后**计算，true 时一律不回收。与 `resolveSharedByOtherSession` 同时给时取
   * 二者之或。
   *
   * 调用方必须用 `isConversationSessionDirectoryInUseAcrossProcesses`（进程内注册表 + 会话库，
   * 拿不到事实即视为在用）而不是只查注册表：只查注册表会漏掉**别的 app-server**里继承同一
   * 执行 cwd 的 fork / 侧会话，rmdir 掉它们正在用的空目录。
   */
  sharedByOtherSession?: boolean | undefined;
  /**
   * 跨进程复检的**惰性**来源：只有判定链（enabled → 形状 → 所有权 → 非空目录）全部通过、
   * 真的要动 `rmdir` 之前才被调用一次。删除是高频率操作，而项目工作区 / 远端 / 未注入标记
   * 的宿主每次都必然在 enabled 一步被拒——急切求值会让这些场景为「注定不回收」的删除白跑
   * 一次全表 `listSessions`，违背本模块「规则不适用即零 IO」（启动清扫同口径：先查 env 标记
   * 再动手）。resolver 抛错按「拿不到事实 = 在用」处理，不影响删除结果。
   */
  resolveSharedByOtherSession?: (() => Promise<boolean>) | undefined;
  logger?: ConversationSessionReclaimLogger | undefined;
}

/**
 * 日志实现自身的异常不能外溢：回收链路的存在意义是「不阻断」，不是「必须报到」。
 * （协议桥里 logger 抛错越过 PONR 冒泡过一次，这里不再给它那条路。）
 */
function logBestEffort(log: () => void): void {
  try {
    log();
  } catch {
    // 日志失败不影响会话删除与启动。
  }
}

/**
 * 会话删除边界的回收接线：判定 + 尽力回收 + 一次性日志。
 *
 * **绝不影响删除结果**：任何失败（目录非空、不存在、权限不足、判定本身异常、日志异常）都只
 * 记日志并返回 false，不抛给调用方——删除会话是产品语义，清空目录只是它的旁路副作用。
 */
export async function reclaimConversationSessionDirOnDelete(
  input: ConversationSessionReclaimInput,
): Promise<boolean> {
  try {
    return await reclaimConversationSessionDirForDeletedRecord(input);
  } catch (error) {
    logBestEffort(() =>
      input.logger?.warn("conversation session dir reclaim failed; deletion continues", {
        // 只记稳定错误码：fs 错误的 message 自带绝对路径，日志规则禁止采集用户路径。
        errorCode: (error as NodeJS.ErrnoException | undefined)?.code,
        sessionId: input.sessionId,
      }),
    );
    return false;
  }
}

async function reclaimConversationSessionDirForDeletedRecord(
  input: ConversationSessionReclaimInput,
): Promise<boolean> {
  const conversationRoot = input.conversationRoot?.trim();
  const executionPath = input.executionPath?.trim() ?? "";
  const enabled = isConversationSessionReclaimEnabled({
    conversationRoot,
    workspaceIdentity: input.workspaceIdentity,
    remoteSessionId: input.remoteSessionId,
    workspaceKey: input.workspaceKey,
  });
  if (
    executionPath.length === 0 ||
    !shouldReclaimConversationSessionDir({
      conversationRoot,
      enabled,
      executionPath,
      sessionId: input.sessionId,
    })
  ) {
    return false;
  }
  // 跨进程复检只在判定链全部通过、真的要 rmdir 之前才求值（急切求值会让项目工作区等
  // 「注定不回收」的删除白跑一次全表查询，见 `resolveSharedByOtherSession` 的注释）。
  // resolver 抛错由外层 catch 收口：记 warn、不回收、删除照常——保守方向 = 保留目录。
  if (input.sharedByOtherSession === true || (await input.resolveSharedByOtherSession?.())) {
    // 「本会话拥有这个目录名」不等于「这个目录只归本会话」：派生会话与父会话共用同一 cwd。
    logBestEffort(() =>
      input.logger?.debug("conversation session dir kept (shared with another live session)", {
        sessionId: input.sessionId,
      }),
    );
    return false;
  }
  const reclaimed = await reclaimEmptyConversationSessionDir({
    conversationRoot: conversationRoot ?? "",
    directory: executionPath,
  });
  // 非空/不存在/权限不足都走「保留」分支，是正常结果而不是错误，只记一次 debug。
  // 日志不带目录路径（会话目录在用户数据根之下，日志规则禁止采集用户路径），用 sessionId 定位。
  logBestEffort(() =>
    input.logger?.debug(
      reclaimed
        ? "conversation session empty dir reclaimed"
        : "conversation session dir kept (not empty or unavailable)",
      { sessionId: input.sessionId },
    ),
  );
  return reclaimed;
}

/** 进程内是否已经排过一次启动清扫：清扫是每进程一次的一次性初始化，不是每次会话创建的前置。 */
let conversationSessionEmptySweepScheduled = false;

/**
 * 测试用：把「已排过清扫」的一次性标志复位。
 *
 * 生产代码只在 app-server 启动装配处调一次，没有第二次调用点；但单测要在**同一个进程**里
 * 反复验证「标志只在真的排了清扫时才置位」（未注入标记 / 缺端口两条 fail-closed 分支都不得
 * 消耗这一次机会），否则断言会依赖同文件内其它用例的执行顺序，`--test-name-pattern` 单跑时
 * 就失去证明力。命名沿用仓库既有的 `…ForTests` 约定（见 core 的
 * `clearWebFetchCacheForTests`）。
 */
export function resetConversationSessionEmptySweepScheduleForTests(): void {
  conversationSessionEmptySweepScheduled = false;
}

/**
 * app-server 启动边界的一次性空目录清扫（fire-and-forget）。
 *
 * 未注入对话根标记（CLI/TUI 直接运行、项目工作区、远端）完全跳过，不产生任何 IO；
 * 清扫只删超过 7 天的**空**会话目录与随之变空的日期目录，且跳过会话库里仍在册的执行目录，失败只记日志。
 * 返回值的语义是「**是否真的排了清扫**」，便于启动装配处与测试断言「未注入即零动作」。
 *
 * 两个 fail-closed 分支都返回 false 且不产生任何 IO：
 * - 未注入对话根标记：本规则不适用（现状）；
 * - 有标记但缺 `sessionPathSource`：**不排清扫**。绝不能静默退回「只按年龄删」的旧行为——
 *   那正是会误删别的进程正在使用的会话目录的版本；某天接线漏了也会在这里留下 warn 而不是
 *   一个看起来正常的年龄清扫。守卫缺席时宁可不清扫（残留目录无害，误删目录会 ENOENT）。
 */
export function scheduleConversationSessionEmptySweep(input: {
  env: Record<string, string | undefined> | undefined;
  logger?: ConversationSessionReclaimLogger | undefined;
  /** 会话库窄面；缺席即 fail-closed（返回 false、零 IO），不会退回年龄清扫。 */
  sessionPathSource?: ConversationSessionPathSource | undefined;
}): boolean {
  if (conversationSessionEmptySweepScheduled) {
    return false;
  }
  const conversationRoot = resolveConversationWorkspaceRootFromEnv(input.env);
  if (!conversationRoot) {
    return false;
  }
  const sessionPathSource = input.sessionPathSource;
  if (!sessionPathSource) {
    // 只记 warn、不带真实路径：这是接线缺陷，不是用户可见的会话事件。
    logBestEffort(() =>
      input.logger?.warn(
        "conversation session empty sweep skipped: session store not wired (fail-closed)",
        {},
      ),
    );
    return false;
  }
  conversationSessionEmptySweepScheduled = true;
  // fire-and-forget：调用方（app-server 启动装配）不等待它，握手与冷启动都不受清扫影响。
  // 「完成」日志由清扫自己在真正跑完时打（见 `sweepEmptyConversationSessionDirs` 末尾）：
  // 放在这里会把「查库失败、一个都没动」也报成 completed，与它前面的 skipped warn 语义相反。
  void sweepEmptyConversationSessionDirs({
    conversationRoot,
    nowMs: Date.now(),
    sessionPathSource,
    ...(input.logger ? { logger: input.logger } : {}),
  }).catch((error: unknown) => {
    logBestEffort(() =>
      input.logger?.warn("conversation session empty sweep failed", {
        // 只记稳定错误码：fs 错误的 message 自带绝对路径，conversationRoot 也是用户数据根
        // 下的真实路径，日志规则都禁止采集。
        errorCode: (error as NodeJS.ErrnoException | undefined)?.code,
      }),
    );
  });
  return true;
}

/**
 * 删除单个空会话目录，并在日期目录因此变空时一并删除。
 *
 * `rmdir` 对非空目录会失败，这里把失败当作「非空、保留」处理，不做递归删除：
 * 回收的语义边界是「空」，任何需要 `rm -rf` 才能删掉的东西都不属于自动回收范围。
 *
 * 日期目录必须先用 `lstat` 确认是**真目录**：包含判定全是词法的，而 `rmdir` 会跟随中间符号链接——
 * 用户把 `<根>/<日期>` 换成指向外部的符号链接时，删的就会是对话根之外的同名目录。
 * `lstat` 不跟随链接，符号链接会被判为「不是目录」而跳过。
 */
export async function reclaimEmptyConversationSessionDir(input: {
  directory: string;
  conversationRoot: string;
}): Promise<boolean> {
  const directory = resolve(input.directory);
  const dateDir = resolve(join(directory, ".."));
  if (!(await isRealDirectory(dateDir))) {
    return false;
  }
  if (!(await removeIfEmpty(directory))) {
    return false;
  }
  // 只回收形如日期目录的父目录，避免把对话根下的用户自建目录当成容器。
  const dateName = dateDir.split(/[\\/]/u).at(-1) ?? "";
  if (
    dateDir !== resolve(input.conversationRoot) &&
    CONVERSATION_SESSION_DATE_DIR_PATTERN.test(dateName)
  ) {
    await removeIfEmpty(dateDir);
  }
  return true;
}

/**
 * 启动清扫：删除超过 7 天的空会话目录与随之变空的日期目录，返回删除的会话目录数。
 *
 * 清扫开始前先读一次会话库（`sessionPathSource`），把库里所有非空 `path` 规范化后当作「在册执行
 * 目录」：命中集合的目录**一律跳过**，即使年龄已超——年龄只是本进程能看见的事实，跨进程还有别的
 * CLI 进程正在用这些目录（见模块头）。
 *
 * 查库失败时**一个目录都不删**并返回 0（只记 warn）：破坏性操作拿不到事实就不动手。失败必须
 * fail-closed，否则一次数据库瞬时不可用就会退化成「只按年龄删」，正好命中要修的那个盲区。
 *
 * 内层循环只处理**名字形状是本规则铸造的**目录（8 / 12 位小写十六进制，
 * `CONVERSATION_SESSION_DIR_NAME_PATTERN`）：空 + 超期不是删目录的充分条件，用户在
 * `<对话根>/<日期>/` 下手建的空目录不属于本规则，与删除边界的所有权判定保持同一强度。
 */
export async function sweepEmptyConversationSessionDirs(input: {
  conversationRoot: string;
  nowMs: number;
  maxAgeMs?: number;
  /** 会话库窄面（必填）：拿不到在册集合就不清扫。 */
  sessionPathSource: ConversationSessionPathSource;
  logger?: ConversationSessionReclaimLogger | undefined;
}): Promise<number> {
  const root = resolve(input.conversationRoot);
  const maxAgeMs = input.maxAgeMs ?? CONVERSATION_SESSION_EMPTY_SWEEP_AGE_MS;
  const registered = await readRegisteredConversationSessionDirs(input.sessionPathSource);
  if (!registered) {
    logBestEffort(() =>
      input.logger?.warn("conversation session empty sweep skipped: session registry unavailable", {
        removedCount: 0,
      }),
    );
    return 0;
  }
  let removed = 0;
  for (const dateEntry of await readDirectoryEntries(root)) {
    if (!dateEntry.isDirectory() || !CONVERSATION_SESSION_DATE_DIR_PATTERN.test(dateEntry.name)) {
      continue;
    }
    const dateDir = join(root, dateEntry.name);
    // 日期目录的年龄必须在动子目录**之前**读取：rmdir 子目录会把父目录 mtime 刷成现在，
    // 之后再判断年龄就永远不到期，空日期目录会永久残留。
    const dateAge = await directoryAgeMs(dateDir, input.nowMs);
    for (const sessionEntry of await readDirectoryEntries(dateDir)) {
      if (!sessionEntry.isDirectory()) {
        continue;
      }
      // 名字形状必须恰好是本规则铸造的形态（8 / 12 位小写十六进制）：年龄 + 空目录只是必要条件，
      // 删除边界（`shouldReclaimConversationSessionDir`）本来就要求名字由会话 id 派生，清扫过去比它
      // 宽——会把用户在 `<对话根>/<日期>/` 下手建的空目录（如 `notes/`）也删掉。非本规则命名的
      // 目录一律不碰。
      if (!CONVERSATION_SESSION_DIR_NAME_PATTERN.test(sessionEntry.name)) {
        continue;
      }
      const sessionDir = join(dateDir, sessionEntry.name);
      const age = await directoryAgeMs(sessionDir, input.nowMs);
      if (age === undefined || age < maxAgeMs) {
        continue;
      }
      // 在册目录跳过（目录级判定，只对已经过年龄门的目录记日志，噪声有界）。
      if (registered.has(await conversationSessionDirectoryKey(sessionDir))) {
        logBestEffort(() =>
          input.logger?.debug("conversation session empty dir kept (registered in session store)", {
            directoryName: sessionEntry.name,
          }),
        );
        continue;
      }
      if (await removeIfEmpty(sessionDir)) {
        removed += 1;
      }
    }
    if (dateAge !== undefined && dateAge >= maxAgeMs) {
      await removeIfEmpty(dateDir);
    }
  }
  // 「完成」只在真正跑完（拿到了在册集合、走完目录树）时打：跳过/中止路径各自打自己的 warn。
  // 日志不带对话根全路径（用户数据根之下的真实路径），用删除计数定位。
  logBestEffort(() =>
    input.logger?.debug("conversation session empty sweep completed", {
      removedCount: removed,
    }),
  );
  return removed;
}

async function readDirectoryEntries(
  directory: string,
): Promise<Array<{ name: string; isDirectory(): boolean }>> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    // 对话根或日期目录不存在（从未建过会话，或刚被清空）不是错误。
    return [];
  }
}

/** 目录年龄按调用方给的 nowMs 计算：年龄门禁必须相对同一次判断的时刻，不受系统时钟漂移影响。 */
async function directoryAgeMs(directory: string, nowMs: number): Promise<number | undefined> {
  try {
    const info = await stat(directory);
    return nowMs - info.mtimeMs;
  } catch {
    return undefined;
  }
}

async function removeIfEmpty(directory: string): Promise<boolean> {
  try {
    await rmdir(directory);
    return true;
  } catch {
    // 非空、不存在或权限不足都保持原状：回收是尽力而为的旁路，不阻断会话生命周期。
    return false;
  }
}

/** 是否是**真目录**（不跟随符号链接）：词法包含判定挡不住中间链接，破坏性路径要自己确认。 */
async function isRealDirectory(directory: string): Promise<boolean> {
  try {
    return (await lstat(directory)).isDirectory();
  } catch {
    return false;
  }
}
