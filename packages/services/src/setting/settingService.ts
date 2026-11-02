import { access, readFile, mkdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { AppSettings } from "@zcode/shared";
import { ZCODE_USER_DATA_DIR_NAME, appSettingsPatchSchema, appSettingsSchema } from "@zcode/shared";
import type { ISettingService } from "./setting.js";
import { normalizeSettingsPatch } from "#src/setting/normalizeSettingsPatch.js";
import {
  copyDataDirectory,
  getAgentUserInstructionsFilePath,
  getDataBaseDir,
  validateDataBaseDirTarget,
} from "../paths.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { createUserInstructionsPersistence } from "#src/setting/userInstructionsPersistence.js";
import { withFileLock } from "@zcode/shared/node";
import { withSettingsWriteQueueTimeout } from "./settingsWriteQueue.js";
import {
  migrateLegacyAccountConnectionSettings,
  needsLegacyAccountConnectionMigration,
  readLegacyAccountConnectionSettingsFile,
  readIncompleteLegacyTeamConnections,
  retainLegacyAccountConnectionFields,
} from "#src/setting/legacyAccountConnectionSettings.js";
const MAX_RECENT_PROJECTS = 10;
const SETTINGS_PARSE_RETRY_DELAY_MS = 300;
const SETTINGS_PARSE_RETRY_COUNT = 3;

const logger = createServiceLogger("settingService");

function resolveUserHomeDir() {
  // 独立桌面 Dev 实例已设置自己的 home，设置服务却仍写真实 HOME，
  // 导致启动迁移和外观操作污染其他实例。与 Electron 的显式 home 覆盖保持一致。
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getSettingsDir() {
  return join(resolveUserHomeDir(), ZCODE_USER_DATA_DIR_NAME, "v2");
}

function getSettingsFile() {
  return join(getSettingsDir(), "setting.json");
}

function defaultSettings(): AppSettings {
  return appSettingsSchema.parse({});
}

function buildCorruptSettingsBackupPath(settingsFile: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${settingsFile}.corrupt-${timestamp}`;
}

async function quarantineCorruptSettingsFile(settingsFile: string): Promise<void> {
  const backupPath = buildCorruptSettingsBackupPath(settingsFile);
  try {
    // 用户手动编辑或远端磁盘异常可能把 setting.json 写成非 JSON（例如 ":wq"）。
    // 如果只返回默认值不隔离坏文件，每次启动都会重复解析失败；这里保留备份后让后续 update 重建合法配置。
    maybeThrowInjectedFsFault({ operation: "rename", path: settingsFile });
    await rename(settingsFile, backupPath);
    logger.warn(undefined, "invalid settings json quarantined");
  } catch (renameError) {
    if (
      renameError &&
      typeof renameError === "object" &&
      "code" in renameError &&
      (renameError as { code?: string }).code === "ENOENT"
    ) {
      // 启动时多个服务可能同时读取同一个坏 setting.json。
      // 第一个读取已经完成隔离后，后续读取再 rename 会遇到 ENOENT；这是并发下的预期结果，不应当按备份失败刷错误日志。
      logger.debug(undefined, "invalid settings json already quarantined");
      return;
    }
    logger.warn(undefined, "settings quarantine failed, returning defaults", renameError);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldPersistSettingsMigrations(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return false;
  const raw = rawValue as Record<string, unknown>;
  return (
    // 原因：只在内存迁移仍会把磁盘上的 3 留给回滚客户端；必须走现有写锁落盘。
    raw.remoteBoundaryOnboardingVersion === 3 ||
    (needsLegacyAccountConnectionMigration(rawValue) &&
      readIncompleteLegacyTeamConnections(rawValue).length === 0) ||
    raw.closeToTrayOnWindowsMigrationInitialized !== true ||
    raw.messageStreamShowReasoningMigrationInitialized !== true ||
    raw.taskAutoArchiveResetVersion !== 1
  );
}

interface ReadSettingsResult {
  settings: AppSettings;
  needsMigrationPersist: boolean;
}

async function readSettingsWithMeta(settingsFile = getSettingsFile()): Promise<ReadSettingsResult> {
  try {
    // 纯 HTTP 宿主没有全局 console 净化，必须在服务出口过滤；debug 也不能输出配置或路径。
    logger.debug(undefined, "reading settings");
    const raw = await readFile(settingsFile, "utf-8");
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(raw);
    } catch {
      // setting.json 可能正被另一次 update 覆盖写入，读者会短暂读到半截 JSON。
      // 先做短重试，只有连续失败才按坏文件隔离，避免把正常会话配置误清成默认值。
      for (let retryAttempt = 1; retryAttempt <= SETTINGS_PARSE_RETRY_COUNT; retryAttempt += 1) {
        await delay(SETTINGS_PARSE_RETRY_DELAY_MS);
        try {
          rawValue = JSON.parse(await readFile(settingsFile, "utf-8"));
          break;
        } catch {
          // 连续重试后才隔离；解析错误可能携带配置原文，不能进入日志。
        }
      }
      if (rawValue === undefined) {
        await quarantineCorruptSettingsFile(settingsFile);
        return {
          settings: defaultSettings(),
          needsMigrationPersist: false,
        };
      }
    }
    const result = appSettingsSchema.safeParse(migrateLegacyAccountConnectionSettings(rawValue));
    if (!result.success) {
      logger.warn(undefined, "settings schema validation failed, returning defaults");
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }
    logger.debug(undefined, "settings read completed");
    return {
      settings: result.data,
      needsMigrationPersist: shouldPersistSettingsMigrations(rawValue),
    };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      logger.debug(undefined, "settings file missing, using defaults");
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }

    // 文件解析失败等异常兜底返回默认值
    logger.warn(undefined, "settings read failed, returning defaults", err);
    return {
      settings: defaultSettings(),
      needsMigrationPersist: false,
    };
  }
}

async function readSettings(settingsFile = getSettingsFile()): Promise<AppSettings> {
  return (await readSettingsWithMeta(settingsFile)).settings;
}

async function writeSettings(
  settings: AppSettings,
  shouldCommit: () => boolean = () => true,
  runExclusiveCommit: (commit: () => Promise<void>) => Promise<void> = (commit) => commit(),
  enterCommitPhase: () => void = () => undefined,
  commitAccountSelection = false,
  settingsFile = getSettingsFile(),
): Promise<void> {
  const settingsDir = dirname(settingsFile);
  // Windows 下测试只改了 HOME，模块顶层常量如果在导入时就把 homedir() 固化，
  // 后续读写仍会串到真实用户目录。这里改成每次按当前环境解析配置路径，保证本地和测试都稳定。
  logger.debug(undefined, "writing settings");
  maybeThrowInjectedFsFault({ operation: "mkdir", path: settingsDir });
  await mkdir(settingsDir, { recursive: true });
  if (!shouldCommit()) return;
  maybeThrowInjectedFsFault({ operation: "writeFile", path: settingsFile });
  const raw = await readLegacyAccountConnectionSettingsFile(settingsFile);
  const rollbackFields = retainLegacyAccountConnectionFields(raw);
  const persisted = { ...rollbackFields, ...settings };
  // 旧 Team 缺少组织信息，schema 的默认 {} 不是用户的新选择。
  // 联网补全已移除；普通偏好保存仍保留原字段，不伪造或覆盖历史连接。
  if (!commitAccountSelection && readIncompleteLegacyTeamConnections(raw).length > 0) {
    delete persisted.providerFamilyConnectionSelections;
  }
  await atomicWriteText(settingsFile, JSON.stringify(persisted, null, 2), {
    // 调用方 withFileLock 已持有 setting.json 的跨进程锁，这里再加锁会自我等待到超时。
    useFileLock: false,
    beforeRename: () => {
      if (!shouldCommit()) {
        // 提交前超时的旧写只能清理临时文件，不能晚到 rename 覆盖新语言偏好。
        throw new Error("stale settings write skipped before atomic rename");
      }
      enterCommitPhase();
    },
    runRename: (renameFile) =>
      runExclusiveCommit(async () => {
        if (!shouldCommit()) throw new Error("stale settings write skipped before atomic rename");
        await renameFile();
      }),
  });
  logger.info(undefined, "settings write completed");
}

export interface SettingServiceOptions {
  settingsFilePath?: string;
  fixedDataBaseDir?: string;
}

export function createSettingService(input: SettingServiceOptions = {}): ISettingService {
  const options = { ...input };
  if (
    options.settingsFilePath !== undefined &&
    (!isAbsolute(options.settingsFilePath) || options.settingsFilePath.includes("\0"))
  )
    throw new Error("Invalid settings file path");
  if (
    options.fixedDataBaseDir !== undefined &&
    (!options.settingsFilePath ||
      !isAbsolute(options.fixedDataBaseDir) ||
      options.fixedDataBaseDir.includes("\0"))
  )
    throw new Error("Invalid fixed settings data root");
  // 实例在创建时固定路径，迟到写入不能因宿主环境变化改投另一实例。
  const settingsFile = options.settingsFilePath ?? getSettingsFile();
  const resolveSettingsFile = () => settingsFile;
  const projectSettings = (settings: AppSettings): AppSettings =>
    options.fixedDataBaseDir === undefined
      ? settings
      : { ...settings, dataBaseDir: options.fixedDataBaseDir };
  let updateQueue = Promise.resolve();
  let writeQueueGeneration = 0;
  // 合并曾丢失提交队列；慢rename不能在下一次保存后覆盖新偏好。
  let commitQueue = Promise.resolve();
  const runSettingsCommit = async (commit: () => Promise<void>) => {
    const queued = commitQueue.then(commit, commit);
    commitQueue = queued.catch(() => {});
    await queued;
  };
  const userInstructions = createUserInstructionsPersistence(getAgentUserInstructionsFilePath());

  const enqueueSettingsWrite = async (
    runUpdate: (shouldCommit: () => boolean, enterCommitPhase: () => void) => Promise<void>,
  ) => {
    const runCurrentUpdate = async () => {
      const currentGeneration = ++writeQueueGeneration;
      const shouldCommit = () => currentGeneration === writeQueueGeneration;
      // Bug 原因：Main 与各窗口 Host 各有一个 setting service，原先的跨进程锁只覆盖临时文件写入和
      // rename，两个进程会各自读到旧快照再整文件写回，后写的一方抹掉前者刚保存的字段。
      // 修复依据：与 credentialService 相同，让跨进程锁覆盖读取、合并和原子替换的全过程。
      // 进程内仍走原有 updateQueue 串行，锁只负责跨进程。
      return withFileLock(resolveSettingsFile(), () =>
        withSettingsWriteQueueTimeout(
          (enterCommitPhase) => runUpdate(shouldCommit, enterCommitPhase),
          () => {
            if (writeQueueGeneration === currentGeneration) {
              writeQueueGeneration += 1;
            }
          },
        ),
      );
    };
    const queued = updateQueue.then(
      () => runCurrentUpdate(),
      () => runCurrentUpdate(),
    );
    updateQueue = queued.catch(() => {});
    await queued;
  };

  const service: ISettingService = {
    ...userInstructions,
    async get(): Promise<AppSettings> {
      // 设置切换后可能立即创建或冷恢复 Session；读取若越过已入队写入，
      // runtime 会固定旧开关值。先等待现有写队列，保证启动偏好读取到已提交的选择。
      await updateQueue;
      const result = await readSettingsWithMeta(resolveSettingsFile());
      if (!result.needsMigrationPersist) {
        return projectSettings(result.settings);
      }

      await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
        const latest = await readSettingsWithMeta(resolveSettingsFile());
        if (!latest.needsMigrationPersist) {
          return;
        }

        // 初始化原因：旧版设置可能已把无法区分来源的默认值落盘；升级后按 schema 统一迁移一次。
        // 迁移写盘必须进入 updateQueue，并在队列内重读最新文件，避免覆盖并发保存的其他设置。
        await writeSettings(
          projectSettings(latest.settings),
          shouldCommit,
          runSettingsCommit,
          enterCommitPhase,
          false,
          resolveSettingsFile(),
        );
      });

      return projectSettings(await readSettings(resolveSettingsFile()));
    },

    async update(patch: Partial<AppSettings>, expectedAccountSettings): Promise<void> {
      // Source 根是启动 authority，不是偏好；原先普通 update 可绕过迁移入口改写根，入队前拒绝。
      if (options.fixedDataBaseDir !== undefined && Object.hasOwn(patch, "dataBaseDir"))
        throw new Error("SOURCE_DATA_BASE_DIR_FIXED");
      const runUpdate = async (shouldCommit: () => boolean, enterCommitPhase: () => void) => {
        const validatedPatch = appSettingsPatchSchema.parse(normalizeSettingsPatch(patch));
        const writesConnections =
          Object.hasOwn(validatedPatch, "providerFamilyConnectionSelections") ||
          Object.hasOwn(validatedPatch, "providerFamilyDomain");
        const current = projectSettings(await readSettings(resolveSettingsFile()));
        if (expectedAccountSettings) {
          // 账号查询期间用户可能已手动切换。必须在同一写队列内校验，不能靠调用方先读再写。
          const expected = appSettingsPatchSchema.parse(expectedAccountSettings);
          if (
            current.providerFamilyDomain !== expected.providerFamilyDomain ||
            // 原因：另一窗口重新选择相同身份时映射值不变；旧回滚仍须按操作版本拒绝。
            (expected.providerFamilyDomainUpdatedAt !== undefined &&
              (current.providerFamilyDomainUpdatedAt ?? 0) !==
                expected.providerFamilyDomainUpdatedAt) ||
            JSON.stringify(current.providerFamilyConnectionSelections ?? {}) !==
              JSON.stringify(expected.providerFamilyConnectionSelections ?? {})
          ) {
            throw new Error("Account connection settings changed");
          }
        }
        const merged = appSettingsSchema.parse({
          ...current,
          ...validatedPatch,
        });

        if (writesConnections) {
          // 即使选择值相同也代表一次新操作，版本由同一写锁保证单调递增。
          merged.providerFamilyDomainUpdatedAt = Math.max(
            validatedPatch.providerFamilyDomainUpdatedAt ?? Date.now(),
            (current.providerFamilyDomainUpdatedAt ?? 0) + 1,
          );
        }

        // 打开工作区后会几乎同时写 recentProjects 和 lastWorkspaceSession。
        // 之前两个 update 都是基于各自读到的旧 settings 直接覆盖写回，
        // 后写入的补丁会把前一个字段整块抹掉，导致下次启动恢复不到会话。
        // 这里把写入串行化，让每个补丁都基于上一次真正落盘后的最新状态继续合并。
        if (merged.recentProjects) {
          merged.recentProjects = [...new Set(merged.recentProjects)].slice(0, MAX_RECENT_PROJECTS);
        }

        await writeSettings(
          projectSettings(merged),
          shouldCommit,
          runSettingsCommit,
          enterCommitPhase,
          Object.hasOwn(patch, "providerFamilyConnectionSelections"),
          resolveSettingsFile(),
        );
      };

      await enqueueSettingsWrite(runUpdate);
    },

    async updateDataBaseDir(newDir: string | undefined): Promise<void> {
      if (options.fixedDataBaseDir !== undefined) throw new Error("SOURCE_DATA_BASE_DIR_FIXED");
      const currentBaseDir = getDataBaseDir();
      const targetBaseDir = newDir?.trim() || homedir();
      const validation = validateDataBaseDirTarget(targetBaseDir);
      if (!validation.ok) {
        // Windows 安装目录由安装器/自动更新管理，把 .zcodium/v2 放进去可能在升级时被覆盖。
        // 迁移前在 service 层拦截，避免 UI 入口变化或 RPC 调用绕过前端判断。
        const error = new Error(`${validation.code}: ${validation.forbiddenDir}`);
        (error as Error & { code: string }).code = validation.code;
        throw error;
      }

      if (currentBaseDir !== targetBaseDir) {
        logger.info(undefined, "copying data directory");
        await copyDataDirectory(currentBaseDir, targetBaseDir);
        logger.info(undefined, "data directory copy done");
      }

      await this.update({ dataBaseDir: newDir });
    },
  };

  return service;
}
