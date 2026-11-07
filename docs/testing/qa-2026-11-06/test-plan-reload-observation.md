# Windows E2E reload退出屏障只读观察计划

当前SC90-01首次尝试在正式 `reloadElectronSessionSafely` 的旧进程退出屏障失败，尚未执行配置生成/保存断言。日志只保留泛化错误，缺失 `Error.cause` 中的残留PID，不能确定Windows helper误判或产品生命周期问题。目录沿用测试开始日期2026-11-06，后续执行跨至北京时间11-07。

## 已有证据与假设边界

- `core-retry/evidence/perf/process-samples-0-19.ndjson` 在16:03:29 UTC记录main2052、GPU28904、Network3916、renderer13552、Host24768、cron17836；16:03:32仍有main及部分子进程是正在关闭期间的观察，不证明屏障超时结束仍存活。
- 原始log的delete从16:03:30.359到16:03:34.282，屏障错误在16:03:53.745；时间跨度与正式helper的15s自然退出、3s强杀grace一致，不说明具体残留进程。
- helper已设置 `includeChromeDriverAncestors:false`；仅据超时不能断言ChromeDriver被纳入。Windows PID重复使用与同run旧Worker进程残留均是待验证假设。
- afterEach protocol invalid session是屏障阻止重启后的结果，不能直接登记模型配置写入失败。

## 观察器与接入

外置入口 [reload-observation.cjs](reload-observation.cjs) 只装载 [qa-reload-observer.ts](qa-reload-observer.ts)。由 `qa-project-bootstrap.cjs` 所有者在完整隔离审核后串接：

1. 原beforeEach之后调用 `beginReloadObservation(this,{artifacts,hookSourceSha256})`。
2. 原afterEach之前调用 `finishReloadObservation(this)`；保留SPFV observer和全部原hooks。
3. beforeEach只装配协议delete的只读观察；仅 `shutdownDriver:false` 的正式reload捕获权威main PID与相同身份collector的进程集合。原delete返回时只记录时刻，避免在退出屏障前额外等待采样。
4. afterEach不访问Renderer/失效协议session，保存完整错误cause、原PID在当时是否存在、创建时间、名称与run/home marker布尔值。

每Worker/计数/PID/timestamp独占JSON写入run evidence，附装载时CJS/TS与bootstrap SHA。完整系统命令行仅在进程身份解析时暂存在内存；证据不保存命令行、其它进程路径或配置内容。HOME/TEMP/tsx/npm/所有写入继承获准wrapper的工作树隔离，输出路径检查祖先/重解析点；WMI子进程为隐藏的 `powershell.exe -NoProfile`，只读，无文件写入。

观察器不改变正式helper、应用生命周期、超时、强杀策略、Provider配置和断言；不调用taskkill、不终止进程、不跳过屏障。静态tsc与CJS/tsImport核验只证明装载可用，不能计为reload UI通过。观察器在delete前有只读WMI开销，必须以保存的实际时刻报告，不能把观察批次视为完全没有额外诊断开销。

## 最小运行与后续验收

- 优先SC90单grep；若下一filtered与Browser批次已排定，可复用同观察器收集subagent/task-group和Browser两项保留profile冷重启，不并发启动另一应用。
- 每条reload只有旧main与完整匹配进程退出屏障通过，且新session/bridge实际建立，才称冷重启通过；Provider seed仍必须放在 `afterElectronProcessExit`，不能提前播种。
- 若cause含残留PID，用before/after创建时间及markers区分同一进程、PID复用或不应纳入的ChromeDriver；仅确认collector误判后允许在外置QA调用的现有options中最小适配，保留完整进程退出与写入owner边界。
- 若同一产品main/Host确实在允许退出时间后仍存活，登记运行候选并独立复现；不增加timeout或屏蔽PID使测试绿。

静态验证见 [类型检查](logs/validation-qa-typecheck-observer.json)、[模块装载](logs/validation-reload-observer-static.json)。尚未产生本观察器的实际UI/reload证据，主报告应保留待执行状态。
