/** 纯持久化接口叶子：避免授权 manager 与调用它的 policy 形成反向类型依赖。 */
export interface EmbeddedBrowserSitePermissionRecord {
  [origin: string]: { [permission: string]: "allow" | "deny" };
}

export interface EmbeddedBrowserSitePermissionStore {
  load(): Promise<EmbeddedBrowserSitePermissionRecord>;
  persist(record: EmbeddedBrowserSitePermissionRecord): Promise<void>;
}
