import type { ICredentialService, ISettingService } from "@zcode/services";
import type { WebRemoteControlLogger } from "./logger.js";

/**
 * relay 设备凭据的持久化：deviceSid 落 settings（可随备份走），passHash 落
 * credential store（加密、0600）。半份状态（只有其一）视为损坏，直接清空，
 * 与官方 `createWebRemoteControlRelayAuthStorageProvider` 行为一致。
 */

const PASS_HASH_CREDENTIAL_KEY = "web-remote-control:external-relay:pass_hash";

export interface WebRemoteControlRelayDeviceAuth {
  deviceSid: string;
  passHash: string;
}

export interface WebRemoteControlRelayAuthStorageProvider {
  load(): Promise<WebRemoteControlRelayDeviceAuth | null>;
  save(auth: WebRemoteControlRelayDeviceAuth): Promise<void>;
  clear(): Promise<void>;
  rotate(auth: WebRemoteControlRelayDeviceAuth): Promise<void>;
}

/** 日志脱敏：只暴露 deviceSid 末 6 位与布尔位，不写 secret/hash。 */
function safeAuthLogFields(auth: { deviceSid?: string; passHash?: string }): {
  hasDeviceSid: boolean;
  deviceSidSuffix?: string;
  hasPassHash: boolean;
} {
  const deviceSid = auth.deviceSid?.trim();
  return {
    hasDeviceSid: Boolean(deviceSid),
    deviceSidSuffix: deviceSid ? deviceSid.slice(-6) : undefined,
    hasPassHash: Boolean(auth.passHash?.trim()),
  };
}

export function createWebRemoteControlRelayAuthStorageProvider(params: {
  settingService: ISettingService;
  credentialService: ICredentialService;
  logger: WebRemoteControlLogger;
}): WebRemoteControlRelayAuthStorageProvider {
  const { settingService, credentialService, logger } = params;
  let tail: Promise<void> = Promise.resolve();
  // SID 和 hash 分属两个存储；必须串行完成整次操作，不能让 load 或另一窗口写入插到中间。
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function clear(): Promise<void> {
    await settingService.update({ webRemoteControlExternalRelayDevice: undefined });
    await credentialService.delete(PASS_HASH_CREDENTIAL_KEY).catch(() => undefined);
    logger.info("[web-remote-control] external relay auth cleared", {
      hasDeviceSid: false,
      hasPassHash: false,
    });
  }

  async function load(): Promise<WebRemoteControlRelayDeviceAuth | null> {
    const deviceSid = (
      await settingService.get()
    ).webRemoteControlExternalRelayDevice?.deviceSid.trim();
    const passHash = (await credentialService.load(PASS_HASH_CREDENTIAL_KEY))?.trim();
    if (!deviceSid && !passHash) {
      return null;
    }
    if (!deviceSid || !passHash) {
      logger.warn("[web-remote-control] external relay auth partial state cleared", {
        hasDeviceSid: Boolean(deviceSid),
        hasPassHash: Boolean(passHash),
      });
      await clear();
      return null;
    }
    logger.info("[web-remote-control] external relay auth loaded", {
      ...safeAuthLogFields({ deviceSid, passHash }),
    });
    return { deviceSid, passHash };
  }
  async function save(auth: WebRemoteControlRelayDeviceAuth): Promise<void> {
    try {
      await settingService.update({
        webRemoteControlExternalRelayDevice: { deviceSid: auth.deviceSid },
      });
      await credentialService.save(PASS_HASH_CREDENTIAL_KEY, auth.passHash);
    } catch (error) {
      // 半写入失败不能留下新 SID 配旧 hash；清理失败仍保留原错，不输出可能含凭据的异常文本。
      await clear().catch(() => logger.warn("[web-remote-control] partial auth cleanup failed"));
      throw error;
    }
    logger.info("[web-remote-control] external relay auth saved", {
      ...safeAuthLogFields(auth),
    });
  }
  return {
    load: () => serialize(load),
    save: (auth) => serialize(() => save(auth)),
    clear: () => serialize(clear),
    rotate: (auth) =>
      serialize(async () => {
        await clear();
        await save(auth);
      }),
  };
}
