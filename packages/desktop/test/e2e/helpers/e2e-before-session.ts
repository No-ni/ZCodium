export interface E2EBeforeSessionSetupOptions {
  cid: string;
  specs: string[];
  configureAgentServerEnv: () => void;
  recordBeforeSession: (cid: string, specs: string[]) => void;
  resetHome: (specs: string[]) => Promise<void>;
  startUpstreamHttpIfNeeded: (specs: string[]) => Promise<void>;
  startPluginCdnZipFixtureIfNeeded: (specs: string[]) => Promise<void>;
}

export async function runE2EBeforeSessionSetup(options: E2EBeforeSessionSetupOptions) {
  options.recordBeforeSession(options.cid, options.specs);
  // 修复原因：并行 worker 的日志目录在 recordBeforeSession 内按 cid 设置；随后再配置
  // agent server，子进程才能继承 worker 专属的 ZCODE_LOG_DIR，而不会写到共享日志文件。
  options.configureAgentServerEnv();
  await options.startUpstreamHttpIfNeeded(options.specs);
  await options.startPluginCdnZipFixtureIfNeeded(options.specs);
  // 修复原因：HOME 删除、重建和 fixture seed 是 Electron session 启动的前置事务；
  // 这里必须等待 reset 完成，否则 Windows 文件锁重试期间会用旧 HOME 启动新 Electron。
  await options.resetHome(options.specs);
}
