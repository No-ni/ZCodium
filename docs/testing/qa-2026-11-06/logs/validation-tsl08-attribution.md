# TSL08失效项目恢复：旧断言与当前产品合同

本记录只读源码及既有运行证据，没有操作UI、修改产品或替换reload屏障。`local-canonical`已结束exit1、13case=8PASS/5FAIL；TSL08本项失败不能概括为退出屏障或新任务不可输入。

**实际失败。** [NDJSON](../runtime/qa-menu-20261106-local-canonical/evidence/test-results.ndjson)在18:11:00.349 UTC记录`conversation-session-unavailable-project-draft.test.ts:76`：`target.path`仍是合成失效项目路径，旧断言期待换到其它目录。前一步`waitForV4Pane(pane.sessionId === "draft")`已经完成，但purpose、projectId、目录存在性、正文输入、refresh恢复等后续断言没有抵达。没有把单一draft状态扩认为无项目可发送验收。

**真实冷重启。** [独占reload JSON](../runtime/qa-menu-20261106-local-canonical/evidence/qa-reload-observe-0-8-2-31360-1793988651773.json)显示旧Main30304及12个初始PID在after-test全部不存在；新Main30660创建于18:10:55.7046920 UTC，executable/run/home身份匹配。原delete调用/返回均有时刻；观察器内部第二delete的Main桥接读报WebSocket未连，只写observer-read-error。`test.error:null`的限制保留，失败以NDJSON为准。该轮完成进程替换，不能因此宣称SC90/F98历史失败解决。

**当前产品合同与源码。**

- [2026-11-05当前规范](../../../../docs/specs/projectless-task-workspaces.md:17)规则3明确：已保存的失效项目保留不可用入口与原活动选择，用户可通过统一新建入口进入新任务。
- [Main startup](../../../../packages/desktop/src/main/startupWorkspace.ts:101)以stat/access判断active路径是否可用；119–122仍返回原active warmup及unavailableWorkspacePath。它只准备Agent后备cwd，不替换持久导航身份。
- [Main window装配](../../../../packages/desktop/src/main/index.ts:1633)将unavailableWorkspacePath交给Renderer，同时注入app管理的Agent fallback cwd。
- [Root恢复](../../../../packages/ui/src/root/remoteWorkspaceSessionPersistence.ts:131)从旧entry保留path/purpose，141–154仅添加`unavailable-local-directory`标记；157–159保留原active索引。
- [Agent集成规范](../../../../docs/zcode-agent-app-integration.md:89)要求恢复原workspace/tasks-index/历史，只读浏览，禁止发送及文件树/Git/Terminal等修改入口，Agent可使用安全后备cwd而协议身份保持原值。

旧[workspace-entry-draft](../../../../docs/workspace-entry-draft.md:26)、case catalog的TSL08说明及canonical第76–79行仍期待自动切到conversation的无项目草稿，与当前规范/实现冲突。这是已运行的QA合同与文档漂移，不新增产品BUG。当前现场并未记录完整availability或各只读门禁，不能反过来称只读恢复全部验收通过；合成目录的afterAll清理后不重建其当刻文件状态。

后续应以当前合同独立复验原失效项目仍选中、不可用标记、历史查看/复制和所有写入口禁用；再通过真实统一新建按钮创建新无项目任务，验证新目录/草稿/输入及刷新。保留真实退出屏障、原身份和本树隔离，不让测试自动换导航来掩盖恢复问题。
