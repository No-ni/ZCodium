import { createHash } from "node:crypto";
import { mkdir, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionId, SessionInfo, UpdateSessionInput } from "@zcode/contracts";
import { resolveConversationWorkspaceRoot } from "@zcode/shared/node";
import {
  classifyPersistedConversationExecutionPathUnusable,
  CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON,
  isConversationSessionDateDirUsable,
  isConversationSessionWorkspacePath,
  isPersistedConversationExecutionPath,
  lstatOrUndefined,
  warnConversationSessionDirUnusable,
  type ConversationSessionWorkspaceLogger,
} from "./conversation-session-workspace-guards.js";

// 判据与护栏在 guards 模块（本模块已顶到 400 行有效行上限）：这里原样 re-export，
// 让协议层 / 回收模块 / 测试的既有 import 路径继续可用。
export {
  classifyPersistedConversationExecutionPathUnusable,
  CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON,
  CONVERSATION_SESSION_DIR_UNUSABLE_REASON,
  isConversationSessionDateDirUsable,
  isConversationSessionDirUsable,
  isConversationSessionWorkspacePath,
  isPersistedConversationExecutionPath,
  type ConversationSessionDirUnusableReason,
  type ConversationSessionWorkspaceLogger,
} from "./conversation-session-workspace-guards.js";

/**
 * 对话会话的独立执行目录。
 *
 * 未指定项目的会话共用一个「对话根」（`~/.zcodium/workspace/default`）作为工作区身份，
 * 但执行 cwd 必须按会话隔离，否则并行会话互相看见对方的临时文件与产物。身份与执行目录
 * 的归属不同：**谁是对话根**由 Host 在 spawn 时下发（`ZCODE_CONVERSATION_WORKSPACE_ROOT`），
 * **目录怎么建**归会话所有者 Agent CLI，本模块就是那条唯一规则。
 *
 * 命名规则：`<对话根>/<创建日>/<会话id前8位>`；同名目录对同一会话**幂等复用**，只有 8 位路径被
 * **非目录**占住、或被**别的在册会话**占用（同日不同会话 id 撞前 8 位）时才回退 12 位；
 * 结果随会话持久化，之后不再重算。日期只用于整理与可读性，恢复不从名字反推。见
 * docs/specs/conversation-session-workspace.md。
 *
 * 第三层兜底的有意收窄：定名之前还要确认**日期目录可用**（缺席或 `lstat` 意义上的真目录，
 * 见 `isConversationSessionDateDirUsable`）。`<根>/<日期>` 被普通文件、悬空链接或符号链接占住时，
 * 创建/恢复边界一律返回 undefined，由调用方沿用旧行为 `cwd = workspacePath`——既不删也不修占位者
 * （那是用户的东西），也不跟着链接把目录建到对话根之外。收窄的取舍理由：坏掉的日期目录只影响
 * 「那一天」的会话（降级为共用对话根），而旧写法会让当天所有会话 `mkdir` 报 ENOTDIR（整天确定性
 * 失败），或经符号链接在根外造出词法上"在根内"、回收与清扫却都拒绝的目录（永不被清理）。
 * 残留竞态：检查与 `mkdir` 之间占位者可能被替换，本模块无法消除；那时的失败仍由 `mkdir` 暴露
 * （ENOTDIR），跨进程替换链接仍可能被跟随，属已知边界。
 */

/** 目录名取会话 id 的 uuid 段前 8 位。 */
export const CONVERSATION_SESSION_DIR_NAME_LENGTH = 8;
/** 前 8 位已存在（碰撞）时回退到 12 位。 */
export const CONVERSATION_SESSION_DIR_NAME_FALLBACK_LENGTH = 12;
/**
 * 会话目录名的形状：恰好 8 位或 12 位**小写十六进制**（uuid 段前缀 / sha256 段前缀）。
 *
 * 这是启动清扫「哪些子目录可能是本规则建的」的护栏：年龄 + 空目录只是必要条件，
 * 缺少形状判定时用户在 `<对话根>/<日期>/` 下手建的空目录（如 `notes/`）也会被删掉——
 * 那不是本规则建的目录，清扫无权处理。
 */
export const CONVERSATION_SESSION_DIR_NAME_PATTERN = new RegExp(
  `^[0-9a-f]{${CONVERSATION_SESSION_DIR_NAME_LENGTH}}(?:[0-9a-f]{${
    CONVERSATION_SESSION_DIR_NAME_FALLBACK_LENGTH - CONVERSATION_SESSION_DIR_NAME_LENGTH
  }})?$`,
  "u",
);
/** 日期目录名；只有匹配该形状的子目录才被当作会话容器（清扫与回收的护栏）。 */
export const CONVERSATION_SESSION_DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
/** CLI 铸造的会话 id 前缀。 */
export const CONVERSATION_SESSION_ID_PREFIX = "sess_";
/**
 * 只有 `sess_<uuid>` 形态的 id 才用「前缀」定名：它的前 N 位自带唯一性。
 *
 * 仓库里还存在别的 id 形态（`sess_${"subagent_" + agentId}`、`sess_${"workflow_" + activityId}`、
 * imported-history 的显式 id）。它们的公共前缀完全相同，取前缀会让同一天的所有同类子会话挤进
 * 同一个执行目录（并行子代理互相看见对方的临时文件），并让回收的所有权判定把同一目录判给两个会话。
 */
const CONVERSATION_SESSION_UUID_ID_PATTERN =
  /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface ConversationSessionWorkspacePlan {
  /** 对话根（= 工作区键路径，会话持久化的 `directory`）。 */
  root: string;
  /** `<对话根>/<创建日>`。 */
  dateDir: string;
  /** 会话执行 cwd（会话持久化的 `path`）。 */
  directory: string;
  /** 目录名（会话 id 派生）。 */
  name: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 会话 id → 目录名（同一 id 永远同一名字）。
 *
 * `sess_<uuid>` 取 uuid 段的前 `length` 位（验收 2 的形状）；其余形态（子代理 / workflow 子会话 /
 * imported-history 显式 id / 空 id）取 id 稳定哈希的前 `length` 位——它们没有可区分的前缀，
 * 只有哈希才能保证「不同会话不同目录」。
 */
export function buildConversationSessionDirName(
  sessionId: string,
  length: number = CONVERSATION_SESSION_DIR_NAME_LENGTH,
): string {
  const id = sessionId.trim();
  const nameLength = Math.max(1, length);
  if (CONVERSATION_SESSION_UUID_ID_PATTERN.test(id)) {
    return id
      .slice(CONVERSATION_SESSION_ID_PREFIX.length)
      .replace(/[^a-z0-9]/giu, "")
      .slice(0, nameLength)
      .toLowerCase();
  }
  return createHash("sha256").update(id).digest("hex").slice(0, nameLength).toLowerCase();
}

/** 创建日的**本地**日期目录名（`YYYY-MM-DD`）。跨时区/跨零点都以本地日为准。 */
export function formatConversationSessionDateDir(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 纯规划：把「对话根 + 会话 id + 创建日」映射成目录布局。
 *
 * `existingName` 用于恢复路径——名字一旦确定就随会话持久化，恢复只按名字复用，
 * 不按当前时间重算，因此草稿跨零点也不会漂移到另一天的目录。
 */
export function planConversationSessionWorkspace(input: {
  conversationRoot: string;
  sessionId: string;
  createdAtMs: number;
  existingName?: string | undefined;
}): ConversationSessionWorkspacePlan {
  const root = resolve(input.conversationRoot);
  const name = input.existingName?.trim()
    ? input.existingName.trim()
    : buildConversationSessionDirName(input.sessionId);
  const dateDir = join(root, formatConversationSessionDateDir(input.createdAtMs));
  return { root, dateDir, directory: join(dateDir, name), name };
}

/** 本进程是否对「该 workspace 上的会话」启用独立目录规则。 */
export function isConversationWorkspaceEnabled(input: {
  conversationRoot: string | undefined;
  workspacePath: string;
  workspaceIdentity?: string | undefined;
}): boolean {
  if (input.workspaceIdentity?.trim()) {
    return false;
  }
  const root = input.conversationRoot?.trim();
  if (!root) {
    return false;
  }
  return resolve(root) === resolve(input.workspacePath);
}

/**
 * **创建侧**复用一支的门禁：行里的持久化执行 cwd 还能不能当本次创建的 cwd。
 *
 * 创建边界认持久化事实（导入类创建带 `sessionId` 重放、删除后重新导入、幂等重试）时会把行里的
 * `path` 当 `provided` 交给 `createRecord`，而 provided 分支只做 `ensureConversationSessionWorkspaceDir`
 * ——`isConversationSessionDateDirUsable` 过去只在**铸造新目录**的分支里跑，于是复用一支不过这道门，
 * 重演规则 8 要消灭的两种结局：
 * - `<对话根>/<日期>` 是普通文件 / 悬空链接 ⇒ `mkdir` 抛 ENOTDIR，整个导入创建确定性失败
 *   （规则 8 承诺的是降级为 `cwd = workspacePath`）；
 * - 是**活链接** ⇒ `mkdir(recursive)` 跟随链接把会话目录建到对话根之外：词法包含判定仍说"在根内"，
 *   回收（`isRealDirectory`）与清扫（`dirent.isDirectory`）都拒绝这种中间链接，目录永不回收。
 *
 * 判据与铸造分支同一份（`classifyPersistedConversationExecutionPathUnusable`：日期目录 + 会话目录
 * 两层都是 `lstat` 语义、不跟随链接、不删不修占位者）。不归本规则的持久化路径（项目工作区 / 远端）
 * 没有这两层，一律视为可复用：它们的目录存在性由 Host / 远端机器负责
 * （见 `resolveRecordExecutionWorkspacePath`）。
 */
export function isReusablePersistedConversationExecutionPath(input: {
  conversationRoot: string | undefined;
  persistedPath: string | undefined;
}): boolean {
  const persisted = input.persistedPath?.trim();
  if (!persisted) {
    return false;
  }
  return (
    classifyPersistedConversationExecutionPathUnusable({
      conversationRoot: input.conversationRoot,
      persistedPath: persisted,
    }) === undefined
  );
}

/**
 * 恢复/派生边界在「本次解析没有给出目录」时的兜底裁决：还能不能按持久化 `path` 运行。
 *
 * 只有**本规则不适用**（未注入标记的旧宿主 / 回滚态 / 项目工作区 / 远端）才允许沿用：那种情况下
 * core 的冷恢复无论如何都按 `session.path ?? session.directory` 取 cwd，协议层必须同口径，否则
 * UI 快照会回落对话根、看到的目录不是 Agent 真正落盘的地方。
 *
 * 规则**适用**时一律返回 undefined：此时「解析没有给出目录」的含义是**被拒**（日期目录被文件或
 * 符号链接占位，`resolveConversationSessionWorkspaceForResume` 已判定不可用），兜回 `session.path`
 * 会把那条裁决丢掉——`createRecord` 的 provided 分支随后 `mkdir`：日期目录是文件时抛 ENOTDIR
 * （恢复整体失败），是符号链接时把会话目录建到对话根之外（词法说在根内，回收与清扫都不认）。
 * 这是**降级写回失败**（库写不动）时的最后一道守卫；写回成功时调用方拿到的是工作区键路径。
 */
export function resolvePersistedConversationExecutionFallback(input: {
  conversationRoot: string | undefined;
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  persistedPath: string | undefined;
}): string | undefined {
  if (
    isConversationWorkspaceEnabled({
      conversationRoot: input.conversationRoot,
      workspaceIdentity: input.workspaceIdentity,
      workspacePath: input.workspacePath,
    })
  ) {
    return undefined;
  }
  const persisted = input.persistedPath?.trim();
  return persisted && isPersistedConversationExecutionPath(persisted, input.workspacePath)
    ? resolve(persisted)
    : undefined;
}

/**
 * 首次创建时定名，对同一会话**幂等**：同名条目已经是真目录、且不被**别的在册会话**占用时复用它。
 *
 * 为什么必须是「同名目录 = 我的目录」而不是「同名就换名」：名字由会话 id 派生，第二次解析
 * （写库失败后的重试、并发冷恢复、带 sessionId 的导入二次创建）看到的就是**自己**上一次的目录。
 * 若这时回退 12 位，行会被 upsert 到新目录（`on conflict do update set path`），前一次目录里
 * 已经写下的文件就永远不再属于这个会话，而且因为非空也不会被空目录回收——静默、永久、
 * 与规格「名字一旦确定即随会话持久化，不再重算」直接冲突。
 *
 * 12 位留给两种情况：
 * - 8 位路径被**非目录**占住（同名文件 / 符号链接）：换名能给新会话一条活路。失败形态按占位者
 *   类型不同——普通文件与悬空链接会让 `mkdir` 报 ENOTDIR/ENOENT（确定性失败），指向别处的**活
 *   链接**则会让 `mkdir(recursive)` 跟随链接**成功**、把目录建到对话根之外（回收与清扫都不认）；
 *   所以判存在必须是 `lstat` 语义（不跟随链接，见下）；
 * - 8 位路径被**别的在册会话**占用（`occupiedDirectories` 命中）：两个会话 id 撞了前 8 位
 *   （同日不同会话，量级 2^-32）。调用方（协议创建边界）能从进程内注册表分辨出"这个目录是
 *   别人的"，因此这里不再把碰撞当成"自己的残留"——判据只对**别的会话**成立：本次会话自己的
 *   目录/上一次尝试的残留不在集合里（调用方按 sessionId 排除），所以重试仍然复用同一个名字，
 *   幂等不受影响。占用是词法判定（`resolve` 规范化后比较），不要求目录此刻存在：手工删掉目录
 *   不会让另一个会话拿走这个名字。
 *
 * 12 位也被别的会话占用时不做第三层兜底：沿用长名，真正建不出来由 `mkdir` 报错暴露。
 */
export function resolveConversationSessionDirNameForCreate(input: {
  conversationRoot: string;
  sessionId: string;
  createdAtMs: number;
  /**
   * 「被**别的在册会话**占用」的执行目录（本次会话自己的目录必须已由调用方排除）。
   * 缺省 = 现有行为（同名真目录一律复用），不传集合的调用方语义不变。
   */
  occupiedDirectories?: Iterable<string> | undefined;
}): string {
  const short = buildConversationSessionDirName(
    input.sessionId,
    CONVERSATION_SESSION_DIR_NAME_LENGTH,
  );
  const dateDir = join(
    resolve(input.conversationRoot),
    formatConversationSessionDateDir(input.createdAtMs),
  );
  const shortPath = join(dateDir, short);
  // 占用判定先于「是否存在」：目录被手工删掉但另一个在册会话仍认领它时，也不能把这个名字给它。
  if (isDirectoryOccupiedByOtherSession(input.occupiedDirectories, shortPath)) {
    return buildConversationSessionDirName(
      input.sessionId,
      CONVERSATION_SESSION_DIR_NAME_FALLBACK_LENGTH,
    );
  }
  // 只有「不存在」或「已经是真目录」才复用 8 位。判存在必须用 `lstat`（不跟随链接）：
  // `existsSync` 跟随符号链接，对**悬空链接**返回 false——那会绕过下面这条护栏，用 8 位去
  // `mkdir`，而 `mkdir(recursive)` 对悬空链接报 ENOENT（活链接则会把内容写到链接目标里）。
  // 两种链接都算占位、都回退 12 位：链接不是本规则建的目录（可能是用户把会话目录软链到外接盘、
  // 或同步工具留下的断链），跟着它写会写到对话根之外。
  const shortEntry = lstatOrUndefined(shortPath);
  if (!shortEntry || shortEntry.isDirectory()) {
    return short;
  }
  // 12 位仍被占用时沿用长名：`ensureConversationSessionWorkspaceDir` 对「同一个会话重复创建」
  // 是幂等的，重复创建不该再造第三个目录；12 位是**非目录**（同名文件 / 悬空链接）占位时由
  // `mkdir` 报错暴露（若 12 位恰是另一个会话的目录，mkdir 幂等成功 ⇒ 会共用目录，量级 2^-48，
  // 见 spec 已知边界 11）。
  return buildConversationSessionDirName(
    input.sessionId,
    CONVERSATION_SESSION_DIR_NAME_FALLBACK_LENGTH,
  );
}

/** 候选目录是否落在「被别的在册会话占用」集合里（`resolve` 规范化后比较，尾分隔符/相对写法不漏判）。 */
function isDirectoryOccupiedByOtherSession(
  occupiedDirectories: Iterable<string> | undefined,
  candidate: string,
): boolean {
  if (!occupiedDirectories) {
    return false;
  }
  const target = resolve(candidate);
  for (const directory of occupiedDirectories) {
    if (typeof directory !== "string") {
      continue;
    }
    const value = directory.trim();
    if (value.length > 0 && resolve(value) === target) {
      return true;
    }
  }
  return false;
}

/**
 * 建立会话执行目录（幂等，含中间日期目录），并刷新目录 mtime。
 *
 * 刷新 mtime 是启动清扫的年龄门禁所必需：门禁的语义是「空且 7 天没人动过」，而 `mkdir` 对已存在
 * 的目录不改 mtime——不刷新的话，一个只做问答、从没写过文件的旧会话目录会被当成「建了 7 天没人用」
 * 删掉，正在使用它的 runtime 下一次相对写入就 ENOENT。创建、恢复、fork 继承都会经过这里，
 * 于是「最近被激活过」等价于「最近被动过」。刷新失败不影响会话本身。
 */
export async function ensureConversationSessionWorkspaceDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const now = new Date();
  await utimes(directory, now, now).catch(() => undefined);
}

/**
 * 一次「会话执行 cwd 从哪来」的裁决结果。
 *
 * `directory` 是会话持久化的 `path`（Agent 真正落盘的地方）；`backfilled` 只用于日志与测试，
 * 表达「这次不是复用持久化路径，而是给存量会话补发目录」。
 */
export interface ConversationSessionWorkspaceResolution {
  /** 会话执行 cwd（会话持久化的 `path`）。 */
  directory: string;
  /**
   * true = 存量会话补发：持久化 `path` 仍等于对话根，本次按会话自身创建日补发目录。
   * 补发结果随会话持久化，因此**只会发生一次**，之后恢复走复用分支。
   */
  backfilled: boolean;
}

/**
 * 创建边界判定：启用对话根规则时给出 `<根>/<创建日>/<会话id前8位>`；未启用返回 undefined。
 *
 * 未启用（未注入标记 / 带 workspaceIdentity / 路径不等于对话根）时必须返回 undefined 而不是
 * 退化成对话根目录——调用方据此沿用旧行为 `cwd = workspacePath`，项目工作区与 CLI/TUI
 * 独立运行不受影响。目录创建由调用方用 `ensureConversationSessionWorkspaceDir` 完成。
 *
 * `occupiedDirectories` 是可选输入，只在**创建边界**用得上（见
 * `resolveConversationSessionDirNameForCreate`）：恢复/补发分支复用持久化路径或已落库的名字，
 * 不参与「8 位是否被别人占了」的判定，因此那些调用方不传即可保持现有行为。
 *
 * 日期目录不可用（普通文件 / 符号链接，含悬空链接）时返回 undefined 并记一次 warn：定名之后
 * 无论用 8 位还是 12 位都必须经过 `mkdir`，而那正是会失败或写到根外的动作，没有安全的兜底名字。
 */
export function resolveConversationSessionWorkspaceForCreate(input: {
  conversationRoot: string | undefined;
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  sessionId: string;
  createdAtMs: number;
  /** 「被别的在册会话占用」的执行目录；缺省 = 不参与 8 位复用判定。 */
  occupiedDirectories?: Iterable<string> | undefined;
  /** 日期目录不可用时的 warn 出口；缺省只返回 undefined（不产出日志）。 */
  logger?: ConversationSessionWorkspaceLogger | undefined;
}): ConversationSessionWorkspaceResolution | undefined {
  if (!isConversationWorkspaceEnabled(input)) {
    return undefined;
  }
  // 启用 ⇒ 对话根非空；`?? ""` 只是类型收口，用于让本函数保持纯函数（不抛错）。
  const conversationRoot = resolve(input.conversationRoot ?? "");
  // 定名之前先确认日期目录可用：子路径的 lstat 在父目录被占住时一律 ENOENT，
  // 只看最后一段会让"坏掉的日期目录"被当成"名字空闲"。
  const dateDir = join(conversationRoot, formatConversationSessionDateDir(input.createdAtMs));
  if (!isConversationSessionDateDirUsable(dateDir)) {
    warnConversationSessionDirUnusable(input.logger, CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON);
    return undefined;
  }
  const name = resolveConversationSessionDirNameForCreate({
    conversationRoot,
    createdAtMs: input.createdAtMs,
    ...(input.occupiedDirectories ? { occupiedDirectories: input.occupiedDirectories } : {}),
    sessionId: input.sessionId,
  });
  return {
    backfilled: false,
    directory: planConversationSessionWorkspace({
      conversationRoot,
      createdAtMs: input.createdAtMs,
      existingName: name,
      sessionId: input.sessionId,
    }).directory,
  };
}

/**
 * 恢复边界判定：优先复用持久化路径，其次给存量会话补发一次；未启用返回 undefined。
 *
 * 三个输入的分工必须分清，混用任何两个都会让工作区身份漂移：
 * - `workspacePath` / `workspaceIdentity`：**工作区键路径**（resume 请求里的对话根），只用于
 *   判断本规则是否启用；
 * - `persistedPath`：**会话执行 cwd** 的持久化事实，复用分支只认它，不从会话 id 重算、
 *   也不用当前时间重算日期（草稿跨零点不会漂到另一天）；
 * - `persistedDirectory`：旧记录可能没有 `path`，退回它判断存量。
 *
 * 持久化目录既不是对话根也不在其下时返回 undefined：那不是本规则的会话（项目工作区、
 * 远端 identity 路径等），不能被劫持进对话根目录树。
 *
 * 日期目录不可用时返回 undefined 并记一次 warn，**两个分支都判**：复用分支之后要按持久化 cwd
 * `mkdir`，补发分支之后要铸造新目录，两条路都会经过坏掉的日期目录（普通文件 ⇒ ENOTDIR，
 * 符号链接 ⇒ 写到根外），所以都不能放行。
 */
export function resolveConversationSessionWorkspaceForResume(input: {
  conversationRoot: string | undefined;
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  sessionId: string;
  persistedPath?: string | undefined;
  persistedDirectory?: string | undefined;
  createdAtMs: number;
  /** 日期目录不可用时的 warn 出口；缺省只返回 undefined（不产出日志）。 */
  logger?: ConversationSessionWorkspaceLogger | undefined;
}): ConversationSessionWorkspaceResolution | undefined {
  if (!isConversationWorkspaceEnabled(input)) {
    return undefined;
  }
  // 启用 ⇒ 对话根非空；`?? ""` 只是类型收口，用于让本函数保持纯函数（不抛错）。
  const conversationRoot = resolve(input.conversationRoot ?? "");
  const persisted = input.persistedPath?.trim() || input.persistedDirectory?.trim();
  if (persisted && isConversationSessionWorkspacePath(persisted, conversationRoot)) {
    // 复用分支：调用方随后会对这个 cwd 幂等 mkdir，因此 `<日期>` 与**会话目录自身**两层都必须
    // 是真目录，否则同一个坏占位者会把「恢复」也变成 EEXIST/ENOTDIR（整次恢复失败）或根外写入
    // （跟随符号链接）。判据与创建侧复用门禁共用 `classifyPersistedConversationExecutionPathUnusable`。
    const directory = resolve(persisted);
    const unusableReason = classifyPersistedConversationExecutionPathUnusable({
      conversationRoot,
      persistedPath: directory,
    });
    if (unusableReason) {
      warnConversationSessionDirUnusable(input.logger, unusableReason);
      return undefined;
    }
    // 名字随会话持久化：恢复只按它复用，日期段只用于整理与可读性，恢复期不重算。
    return { backfilled: false, directory };
  }
  if (persisted && resolve(persisted) !== conversationRoot) {
    return undefined;
  }
  // 存量会话（`path` 仍等于对话根，或旧记录没有 `path`）：按**该会话自身的创建日**补发。
  const dateDir = join(conversationRoot, formatConversationSessionDateDir(input.createdAtMs));
  if (!isConversationSessionDateDirUsable(dateDir)) {
    warnConversationSessionDirUnusable(input.logger, CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON);
    return undefined;
  }
  const name = resolveConversationSessionDirNameForCreate({
    conversationRoot,
    createdAtMs: input.createdAtMs,
    sessionId: input.sessionId,
  });
  return {
    backfilled: true,
    directory: planConversationSessionWorkspace({
      conversationRoot,
      createdAtMs: input.createdAtMs,
      existingName: name,
      sessionId: input.sessionId,
    }).directory,
  };
}

/**
 * 派生会话（fork、侧会话、subagent 子会话）的执行 cwd 继承。
 *
 * 只在「创建派生会话时已能取到父会话执行 cwd」这一处继承：父 record 上有值就直接用。
 * 子会话随后按同一规则持久化自己的 `path`，冷恢复自然走持久化复用分支，因此**不需要**
 * 第二套「从父会话反推目录」的推断逻辑；父会话还没补发（存量）时返回 undefined，
 * 由调用方走持久化路径判定（子会话行由 core fork 复制父行，天然带着父的 path）。
 */
export function resolveConversationSessionWorkspaceInherited(
  parentExecutionWorkspacePath: string | undefined,
): string | undefined {
  const inherited = parentExecutionWorkspacePath?.trim();
  return inherited ? resolve(inherited) : undefined;
}

/** CLI 入口处读取 Host 下发的对话根标记。 */
export function resolveConversationWorkspaceRootFromEnv(
  env: Record<string, string | undefined> | undefined,
): string | undefined {
  return resolveConversationWorkspaceRoot(env);
}

/**
 * 补发写回需要的会话库窄面（读 + 单字段写）。
 * 复用 contracts 的既有输入/输出类型，不新造第二份存储契约；窄面只为可测与替换。
 */
export interface ConversationSessionPathStore {
  getSession(sessionID: SessionId): Promise<SessionInfo | null>;
  updateSession(input: UpdateSessionInput): Promise<SessionInfo>;
}

/** 补发落盘的结果。`available` 才给出可用的执行 cwd，且它**恒等于库里持久化的 path**。 */
export type ConversationSessionBackfillPersistOutcome =
  /**
   * 库里有可用的 `path`：`directory` 是**重读到的持久化值**，本次 runtime 的 cwd 必须用它。
   * `applied=false` 表示这次补发没落进库（或行被并发改成别的值），调用方据此记 warn；
   * 但 cwd 仍然取 `directory`——runtime 与持久化事实一致优先于「这次算不算补发成功」。
   */
  | { status: "available"; directory: string; applied: boolean }
  /**
   * 拿不到任何可用的持久化 `path`（没有库 / 写库抛错 / 行里 path 为空）：
   * 调用方必须回退旧行为 `cwd = workspacePath`，绝不使用内存里的补发结果。
   */
  | {
      status: "unavailable";
      reason: "store_unavailable" | "write_failed" | "path_missing";
      error?: unknown;
    };

/**
 * 存量会话补发目录的**落盘**：先建目录 → 把 `path` 写回会话库 → 重读该行并以落盘值当结果。
 *
 * 为什么必须写回：冷恢复的执行 cwd 只来自持久化 `path`（core `resumeFromStore` 用
 * `session.path ?? session.directory`）。只改内存 record 的话，运行期在会话目录、库里仍是对话根，
 * 下次恢复（或进程重启）会把 cwd 打回对话根——「补发只发生一次，随后随会话持久化」就成了空话。
 *
 * 为什么以重读值为准：写库可能被并发写覆盖或静默不生效。因此结果始终是重读到的 `path`；
 * 连重读都拿不到才返回 `unavailable`，由调用方回退 `cwd = workspacePath`。两种结果都保证
 * **runtime cwd 恒等于库里持久化的 path**，绝不出现「runtime 在会话目录、库里是对话根」的半状态。
 *
 * `timeUpdated` 必须传旧值：维护性路径写入不能伪装成用户活动（SQL 侧是 `max(time_updated, ?)`），
 * 否则会话会被顶到侧栏最前。
 *
 * 写库失败时**不**回收本次建出的目录：`stat` 与 `mkdir` 之间不原子，「我查看时它不存在」不等于
 * 「它是我建出来的」，跨进程并发冷恢复同一会话时会把另一个进程刚建出的空目录 `rmdir` 掉（那个
 * 进程下一次相对写入即 ENOENT）。残留空目录本身无害：定名对同一会话幂等，同名真目录一律复用，
 * 重试仍落在同一个名字上；真没人要的空目录由启动清扫的 7 天年龄门禁兜底。
 */
export async function persistConversationSessionBackfillDirectory(input: {
  store: ConversationSessionPathStore | undefined;
  sessionId: string;
  directory: string;
  timeUpdated?: number | undefined;
}): Promise<ConversationSessionBackfillPersistOutcome> {
  const store = input.store;
  if (!store) {
    return { status: "unavailable", reason: "store_unavailable" };
  }
  const sessionId = input.sessionId as SessionId;
  let written = false;
  try {
    // 先建目录再写库：不把一个建不出来的路径写进会话库。
    await ensureConversationSessionWorkspaceDir(input.directory);
    await store.updateSession({
      id: sessionId,
      path: input.directory,
      ...(input.timeUpdated === undefined ? {} : { timeUpdated: input.timeUpdated }),
    });
    written = true;
  } catch (error) {
    return { status: "unavailable", error, reason: "write_failed" };
  }
  let persistedPath: string | undefined;
  try {
    persistedPath = (await store.getSession(sessionId))?.path?.trim() || undefined;
  } catch (error) {
    return { status: "unavailable", error, reason: "path_missing" };
  }
  if (!persistedPath) {
    return { status: "unavailable", reason: "path_missing" };
  }
  const directory = resolve(persistedPath);
  return {
    applied: written && directory === resolve(input.directory),
    directory,
    status: "available",
  };
}

/**
 * 「日期目录不可用」的降级落盘：把会话的持久化 `path` 写回**工作区键路径**（执行 cwd 退回
 * 对话根，规格规则 8）。
 *
 * 为什么必须落盘：core 的冷恢复只认库里的 `path`（`resumeFromStore` 无条件用
 * `session.path ?? session.directory`）。协议层「降级为 `cwd = workspacePath`」的裁决只放在内存里
 * 的话，runtime 仍在那个坏掉的会话目录（不存在，或经链接落在对话根之外）里跑，而 UI 快照已经
 * 回落对话根——两边分叉，正是本规则要消灭的那类不一致。
 *
 * 复用补发的同一条落盘机制（先建目录再写库、维护性写入不动 `time_updated`、以重读值为准、
 * 失败不抛错）。写回后该行回到存量形态（`path === directory`）：日期目录恢复可用后，下一次恢复
 * 按**同一个 8 位名**补发（定名对同一会话幂等，同名真目录一律复用），因此不搬目录、不丢文件。
 */
export async function degradeConversationSessionDirectoryToWorkspacePath(input: {
  store: ConversationSessionPathStore | undefined;
  sessionId: string;
  workspacePath: string;
  timeUpdated?: number | undefined;
}): Promise<ConversationSessionBackfillPersistOutcome> {
  return await persistConversationSessionBackfillDirectory({
    directory: input.workspacePath,
    sessionId: input.sessionId,
    store: input.store,
    ...(input.timeUpdated === undefined ? {} : { timeUpdated: input.timeUpdated }),
  });
}

/**
 * 裸 CLI/TUI 恢复边界的会话目录重建（幂等 mkdir + mtime 刷新，失败不阻断恢复）。
 *
 * 为什么需要它：本特性把 `path` 从「Host 每次都保活的对话根」变成了**可被回收/可被手工删除**
 * 的叶子目录，core 的 `resumeFromStore` 只做 `this.workingDirectory = session.path ??
 * session.directory`（core 业务层禁 fs，建目录只能落在这里）。协议恢复路径（创建/复用/补发/
 * 降级分支）都有 `ensureConversationSessionWorkspaceDir`，唯独裸 CLI/TUI（`zcode --resume` /
 * `--continue`，与桌面 app-server 同一个 sqlite 库）直接走 core：v4 删除一个空目录会话后
 * （close 语义、行保留、目录已被回收），或用户手工删掉目录后，恢复出的 cwd 不存在——
 * 首个 Bash 即 spawn ENOENT。与协议侧同一份判据：只有「本规则铸造的会话目录」才重建，
 * 项目工作区/远端的目录存在性由宿主/远端负责，绝不代建。
 */
export async function ensureConversationSessionDirForBareResume(input: {
  /** 会话库窄面：拿不到行就不动手（core 侧会按自己的 SessionNotFound 语义报错）。 */
  store: ConversationSessionPathStore | undefined;
  sessionId: SessionId;
  logger?: ConversationSessionWorkspaceLogger | undefined;
}): Promise<void> {
  let session: SessionInfo | null;
  try {
    session = input.store ? await input.store.getSession(input.sessionId) : null;
  } catch (error) {
    // 读不出行不阻断恢复：目录缺席的真实报错会由后续 IO 以 ENOENT 暴露。
    logConversationSessionDirEnsureFailure(input.logger, (error as NodeJS.ErrnoException)?.code);
    return;
  }
  if (!session) {
    return;
  }
  const persisted = session.path;
  if (!persisted || !isPersistedConversationExecutionPath(persisted, session.directory)) {
    return;
  }
  // 规则 8 的两层门禁同样适用于重建：日期目录/末段被文件或活链接占位时 mkdir 要么确定性失败、
  // 要么把目录铸到对话根之外（回收与清扫都不认）。占位者不删不修，直接放弃重建。
  const unusable = classifyPersistedConversationExecutionPathUnusable({
    conversationRoot: session.directory,
    persistedPath: persisted,
  });
  if (unusable) {
    warnConversationSessionDirUnusable(input.logger, unusable);
    return;
  }
  try {
    await ensureConversationSessionWorkspaceDir(persisted);
  } catch (error) {
    logConversationSessionDirEnsureFailure(
      input.logger,
      (error as NodeJS.ErrnoException | undefined)?.code,
    );
  }
}

/** 重建失败的唯一 warn：稳定 message + 稳定错误码，不带任何真实路径。 */
function logConversationSessionDirEnsureFailure(
  logger: ConversationSessionWorkspaceLogger | undefined,
  errorCode: string | undefined,
): void {
  try {
    logger?.warn("conversation session dir restore skipped: ensure failed", { errorCode });
  } catch {
    // 日志失败不影响恢复结果。
  }
}
