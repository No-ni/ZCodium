/** 用户自备端点必须是 ws/wss，避免把页面地址当 relay 使用。 */
export function isRelayWsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}

/** relay WS 地址对应同 origin 托管的移动页 http(s) base。 */
export function deriveRelayHttpBase(relayWsUrl: string): string {
  try {
    const url = new URL(relayWsUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return relayWsUrl;
  }
}
