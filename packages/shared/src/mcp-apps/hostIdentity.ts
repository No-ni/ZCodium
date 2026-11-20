/** 宿主 hostInfo.name；hostInfo.version 只供页面 feature detect，与应用版本无关。 */
export const MCP_APPS_HOST_NAME = "zcode";

export const MCP_APPS_HOST_VERSION = "1";

/** `ui/initialize` 握手超时（端口到达起算）与卸载前 `ui/resource-teardown` 的等待上限。 */
export const MCP_APPS_HANDSHAKE_TIMEOUT_MS = 15_000;

export const MCP_APPS_TEARDOWN_TIMEOUT_MS = 500;
