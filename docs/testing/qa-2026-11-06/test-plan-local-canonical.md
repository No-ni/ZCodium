# 本地 canonical 补测计划（9 specs / 13 it）

状态为 **READY / UI尚未执行**。本计划补充87组矩阵的消息选区、图片另存/引用、文件树搜索、Office预览、调用轨迹、子Agent模型表单、窄宽模型菜单与不可用项目草稿。参数文件为[local-canonical-batch.json](local-canonical-batch.json)。不修改产品、不转正pending、不运行UI/build；后续结果仅按NDJSON/summary及现场证据登记。

## ReplayFixtures参数先行合同

当前wrapper只要任一spec包含`/manual-review/`，就把全局`E2E_PROVIDER_REPLAY_FIXTURE_PATH`设为common.json。当前`resolveUpstreamReplayFixturePaths`对非空configuredFixturePaths直接return，**不会追加case-local fixture**。该混合批包含pending Office，导致同批formal MPS/SSC/TRJ等case-local fixture也被抑制，不能用common-only运行；已有prepare helper不为这些spec另建case server覆盖此值。

经root明确接受，runner已增加`[string]$ReplayFixtures=''`，由root维护；[参数前缀正负检查](logs/e2e-preflight-replay-fixtures-parameter.json)4项实际通过。该证据未构建或启动UI，当前批次的7路径仍要按本计划静态preflight检查。合同：

1. 空参数保持当前pending common默认，不改变已有调用。
2. 非空值为逗号分隔的本树既有`.json`列表；按`packages/desktop`路径基准解析成绝对路径，验证非空、leaf、后缀和工作树边界。
3. 像spec一样检查所有祖先重解析点；fixture父目录及既有子项按当前PS7窄目录消失guard审查，不接受link、junction、redirect、权限错误或仍存在路径读取失败。
4. 仅把经过审查、规范化的列表写入`E2E_PROVIDER_REPLAY_FIXTURE_PATH`。该列表必须覆盖common与本批6个conversation case-local fixture；禁止自动加载整个legacy池或改成capture。
5. 该参数在环境清理/默认pending设置之后应用，避免前面设置的值被覆盖。JSON给出的7个路径是本批有限允许列表。
6. 参数解析或路径审查失败时，在构建与Electron启动之前退出，不放宽产品边界。

## 精确用例筛选

JSON给出9个desktop相对spec及完整it标题组成的一个尾部锚定regex；仅选13项。file-tree排除第三个冷重启case，Office排除OPS03，子Agent仅SE-02/03，toolbar仅responsive。TSL08放在最后一个spec并要求现有reload observer覆盖该case；runner仍使用逐个重复`--spec`，不用单个comma CLI spec字符串。仅启用`-Bootstrap`，不启用`-OpenSidePane`，避免对子Agent设置附加无关launcher前置。

| key     | 范围                                                                     | 数量 |
| ------- | ------------------------------------------------------------------------ | ---- |
| MPS     | Markdown真实预览选区、加到草稿/去重/移除、父任务发送引用、侧边问答       | 1    |
| SSC     | 真实parent与选区、child复用/多开/关闭隔离、active路由与/side             | 1    |
| PIA     | 多格式/Latin1 SVG另存及取消；加引用保留草稿/附件且不发送                 | 2    |
| FTS     | 未展开深层Java搜索打开预览；目录搜索回树定位                             | 2    |
| OPS     | PPTX tooltip字面文本且真实本树PDF导出；XLSX Canvas/形状/图片外链校验     | 2    |
| TRJ     | 真实loopback首发落model-io、80条投影、复制/虚拟搜索/窄布局/33MiB有界尾读 | 1    |
| TOOLBAR | completed seed自建；模型菜单保持打开时240px压缩/恢复与节点/焦点/模型状态 | 1    |
| SE      | user scope切换模型物化默认reasoning；删除已选模型不可恢复/不可保存       | 2    |
| TSL08   | 冷重启默认项目被移动后无项目草稿可输入并刷新保留                         | 1    |

## 运行与证据边界

先完成参数及静态preflight，再由root串行运行。不得把fixture checker、模块注册、路径审查或候选计划计为UI通过。实际失败保存PNG、错误cause、NDJSON、worker日志；不存在的失败图不能引用为现场证据。

```powershell
$qaBatch = Get-Content -LiteralPath '.\docs\testing\qa-2026-11-06\local-canonical-batch.json' -Raw | ConvertFrom-Json
& .\docs\testing\qa-2026-11-06\run-menu-tests.ps1 -RunId $qaBatch.runId -Bootstrap -Specs ($qaBatch.specs -join ',') -Grep $qaBatch.grep -ReplayFixtures ($qaBatch.replayFixtures -join ',')
```

runner参数已实现并完成前缀正负静态验证，仍须本批最终preflight与单实例运行门禁。HOME、USERPROFILE、TEMP/TMP/TMPDIR、APPDATA/LOCALAPPDATA、Corepack/pnpm/npm/cache、Electron profile、download和网络capture全部沿用本树隔离wrapper；实际子进程环境与重解析点仍须每次启动前审查。root现有before/after root hook装配`reload-observation.cjs`与`qa-reload-observer.ts`，只观察runId/HOME对应PID与cause，不改timeout、kill或退出屏障。TSL08失败时不能先归为草稿持久化产品bug。

root已接入精确TOOLBAR目标的`qa-composer-fit-observer.ts`。当前hook的只读[接线preflight](logs/feature-inventory-composer-fit-hook-preflight.json)exit0：原hooks顺序保留，三个excluded context/六次fit hook调用零UI、零动态导入、零路径或reparse审查、零文件读写；匹配目标仍待真实UI。observer的[noEmit/lint/rawJS/TSX preflight](logs/feature-inventory-composer-fit-preflight.json)也重跑exit0。240px首两帧有界保留，终态PNG不充当失败帧；采集错误或缺240px帧不能登记布局bug。该接线不改变9spec/13it与7fixture范围，不把静态准入计为功能通过。

最终静态preflight实际exit0，见[完整证据](logs/feature-inventory-local-canonical-preflight.json)：9个spec精确选13个it、排除14个标题；7个有限fixture JSON无重复ID；566个既有祖先/子项路径未发现symlink/redirect。6个conversation fixture checker全部exit0，FTS/OPS/SE不属于checker支持的域，按不适用记录。Node实际v24.18.0，与mise固定24.14.0的差异保留在证据，未改变运行环境。该检查未执行UI/hooks/build，不作为菜单动作通过。

## 写入与清理范围的只读审查

所有实际位置由JSON runId及wrapper解析：`R=docs/testing/qa-2026-11-06/runtime/<runId>`，`H=R/.e2e-home-<runId>`，`W=H/ZCodeProject`。这些是计划目标路径，启动前必须再次检查实际祖先/子项及子进程环境；不能据静态审查认定运行时不会变化。`.zcode-e2e`仅合成文件夹名，不是旧业务数据目录；业务根为`H/.zcodium`。

| owner               | 直接文件I/O与native出口                                                                                                                                         | 清理及限制                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 公共helper/Host/CLI | H/.zcodium配置、DB、workspace、会话、附件及model-io；W为Agent cwd；R下profile/temp/cache/network/evidence                                                       | clearAppData只指向隔离v2；wrapperafterSession按run身份收尾，不能退出仍有writer时直接seed或删数据                                                          |
| MPS                 | W/.zcode-e2e/markdown-preview-selection/selection.md；R/evidence三张专项PNG                                                                                     | after仅rm该合成目录；真实选区引用、loopback父请求与child路由，不自动发送的断言只覆盖加引用步骤                                                            |
| SSC                 | R/evidence/selection-events.json诊断，Host真实parent/child写H/.zcodium                                                                                          | 多个合成loopback流；after恢复Electron mocks；不直接覆盖任务store                                                                                          |
| PIA                 | W/.zcode-e2e/image-actions的PNG/APNG/BMP/ICO/SVG/Latin1 SVG与saved-\*；R/evidence/image-actions的PNG/JSON                                                       | mock showSaveDialog只给本树target；after rm唯一image-actions。existing.png经DataTransfer/File/ClipboardEvent paste走真实eager upload，不调用系统clipboard |
| FTS                 | W/E2E_FILE_TREE_SHARED_SEARCH/src/main/java/com/example/user/UserProfileService.java                                                                            | 各it/after rm唯一CASE_ROOT；仅前2项，没有第三项重启/.e2e-artifacts路径                                                                                    |
| OPS                 | 从本树fixtures/fs/office-preview-security复制tooltip.pptx/links.xlsx到W/E2E_OFFICE_SECURITY；showSaveDialog mock令真实PDF写R/evidence/office-preview-export.pdf | after rm唯一ROOT；不下载字体。window.open仅受控记录/恢复；合法内部Browser导航只127.0.0.1:9，不请求系统设备                                                |
| TRJ                 | 从H/.zcodium/cli/debug或rollout找到真实当前task model-io；append80条与创建另一mode同名目录；r+ truncate至33MiB后append尾记录                                    | 来源先按current taskId和固定filename核验；tool metadata仅合成展示，不执行这些工具。navigator.clipboard.writeText仅捕获合成文本；不清/读系统clipboard      |
| TOOLBAR             | before创建H/.zcode/commands/e2e-draft-catalog.md，after仅rm此唯一文件；ensureCompletedTask向loopback发固定seed，业务会话在H/.zcodium                            | 只选responsive，它自身幂等准备不依赖前一it。旧目录只作为未消费合成before合同，不验slash；排除旧badge/highspeed与completed-to-draft旧helper断言            |
| SE                  | H/.zcodium/agents的user自定义profile及H/.zcodium/v2/agents-state.json内置override；隔离Provider模型配置删除                                                     | prepareV4ConversationE2E创建/选择本地Provider registry，不调用sendV4Prompt，无额外case fixture。只选user两it，不选workspace旧.zcode或官方插件SE-01/04     |
| TSL08               | H/E2E_UNAVAILABLE_PROJECT→同父-moved；退出屏障后seed H/.zcodium/v2/setting.json；R/evidence PNG/JSON                                                            | after rm唯一movedPath；不覆盖现有真实目录。before/afterRootHook必须有只读reloadobserver证据，无timeout放宽/额外kill                                       |

## CFR延后原因与替代范围

原候选`conversation-session-chat-find-refocus.test.ts`虽fixture checker通过，实际命令为本树W内`git -c commit.gpgsign=false commit -m "test: seed chat find fixture"`（spec:97–104）。用户长期规则要求提交中文且执行前展示；root已明确从批次排除这一项，**不执行英文提交、不修改canonical、不用进程wrapper翻译**。它保持NOT-RUN/DEFERRED，静态结果不作为CMD03功能证据。

CMD03交给新增最短外置suite，用公开导入合成长正文进行对话查找/重复导航，不需要Git commit。当前普通PreviewPane→CodeViewer没有内容find入口，不能声称普通文件查找通过；TaskFindDialog的changes scope由GitPane承载。若以后确需Git baseline，先写中文文案、限定唯一合成仓库、由root展示，再审tree内空config、`GIT_CONFIG_NOSYSTEM=1`、本树空template/hooks与`commit.gpgsign=false`；不得运行外树hooks或签名agent。本批9spec不包含直接git commit命令。

## toolbar旧helper失败边界

filtered的`completed task 的 picker 不跨 scope 自动弹到新 draft`已经真实失败，当前`startNewV4Draft`调用`clickTestIdByDom(TID_TASK_NEW_BUTTON)`，它对tid元素直接`element.click()`。当前tid位于`NewTaskButtonGroup.tsx:27`的无onClick `role=group` DIV，创建handler仅在内部button。该旧helper会返回clicked却未创建任务；不把此超时登记为产品新建任务bug，不重复执行已知错误原case。外置suite点击实际childbutton验证新建动作。当前spec已有afterEach Escape清menu，不能仅因前一badge断言失败推断modal污染。
