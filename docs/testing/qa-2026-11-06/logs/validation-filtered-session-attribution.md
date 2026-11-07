# filtered worker0-0协议失效只读归因

GRP04/05/06在2026-11-06 17:18:39 UTC产生1条失败case，失败位置`conversation-session-task-groups.test.ts:257`。本记录依据正在运行的原始日志、源码、已落盘perf与事后WMI，未操作UI/CDP、终止进程、修改timeout或产品。

## 最后完成动作与失效边界

- 分组真实新建、组内首发与replay响应`E2E_GROUP_READY`抵达；draft移除、member归属与projectId=null检查抵达。
- projects/timeline/grouped三个视图的task行与右键移组菜单均找到并完成打开/关闭。
- 17:18:09.755，setTaskPinned RPC返回；17:18:09.780，focus事件dispatch的execute返回true。
- 17:18:09.781，查找`project-pinned-tasks`的element POST没有响应，30s后超时。
- 独立screenshot GET随后同样30s超时；Electron app quit bridge报response timeout，DELETE session又30s超时。截图请求失败，没有可引用的该失败现场PNG。

源码`project-sidebar/index.tsx:272–279`在grouped视图确实渲染kind=pinned的ProjectTaskRows；`ProjectTaskRows.tsx:134`使用该testid。未发现明显的旧selector合同，也未在当前配置/helper发现显式非零implicit timeout。不能把这些连续协议超时仅解释为普通元素不存在；worker0-0会话在此阶段已无法服务后续协议操作。

原始执行见[filtered日志](e2e-qa-menu-20261106-filtered.log)，关键行9523–9607；[实际case](../runtime/qa-menu-20261106-filtered/evidence/test-results.ndjson)。置顶后显示、后续取消置顶/归档/恢复/成员保留未完成，不能用前半段成功覆盖整条case失败。

## 进程身份与后续worker

[perf](../runtime/qa-menu-20261106-filtered/evidence/perf/process-samples-0-0.ndjson)末次17:18:07记录main19716、renderer19060、GPU31144、network31336、Host12968与cron14172；这个末次发生在挂起前，不能证明超时末刻仍存活或死锁。

17:20:11 worker0-1已启动另一个spec。通过完整隔离runner执行的[只读WMI快照](validation-filtered-process-snapshot-1793985716892.json)在17:21:56发现旧6个PID均不存在，也未找到旧ChromeDriver的60521端口命令；当前同run新main27436创建于17:20:12，后代run/home markers匹配。完整命令与退出0见[执行记录](validation-filtered-process-observation.json)，实现见[只读脚本](validation-filtered-process-observation.mjs)。系统完整命令行仅在内存身份解析，不写证据。

worker0-1随后真实返回toolbar查询并有通过case，因此不能把其断言失败归为worker0-0失效的连带错误。快照发生在旧worker收尾后，不能判断旧进程是自然退出还是由已有runner清理，更不能证明pin/focus导致产品死锁。

## 后续最小复验

仅串行独立Grep GRP04/05/06，保留原replay/owner/path与timeout，记录pin/focus之后的存活PID创建时间、renderer/main响应和最后技术日志。若再次发生同一协议失效，区分驱动与应用事件循环再登记产品候选；无需增加timeout或删除pin等待使测试绿。不存在实际case记录的后续动作仅标未抵达/受阻，不能扩成多个产品Bug。
