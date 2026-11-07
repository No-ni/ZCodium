# 模型菜单240px布局观察计划

本计划只增加外置QA观察器`qa-composer-fit-observer.ts`，不修改产品、canonical断言、layout或timeout。精确匹配`packages/desktop/test/e2e/conversation-session/conversation-session-v4-composer-toolbar.test.ts`与完整标题`keeps the open model picker responsive when the composer shrinks and expands`；其他文件/标题的before/after都不调用browser、不写文件。root在Browser批结束后接入既有bootstrap，作者不修改正在运行的hook。

当前filtered在240px等待fit失败，原case finally会恢复宽度并关闭菜单；afterEach截图不能代表失败时的布局。beforeEach用原始JS字符串安装只读MutationObserver，跟踪外壳/inner toolbar的style.width及fit dataset，初始和变动后两帧采样，合计最多24条。每条包含两个owner的class/dataset/rect、model label/icon/thought显示、leading/trailing/input宽度、DPR与视口；不写style、dataset、焦点、scroll或业务store。

历史存在专用window字段，仅供本case采证。节点更换时重新绑定观察目标；记录合并的变动原因与相对时间。数组满后固定初始两帧和首两张style.width=240px帧，其余滚动保留最近帧，并计数丢弃项，合计不超过24。afterEach先取出历史、disconnect并取消RAF/删除专用字段，再保存终态PNG和独占JSON；原finally恢复不会覆盖已经采到的首两张240px帧。PNG只代表收尾帧，不能称失败帧录像。文件名含worker/计数/PID/时间，路径经工作树内祖先与真实路径检查，使用wx，不覆盖旧证据。

验收先执行目标文件TypeScript noEmit、lint、格式和两段raw script的JS parse；以实际TSX导入检查非精确case的零browser调用/零写入。静态结果不增加业务测试数量。root串行运行后，以至少一个240px帧的shell/inner flag、可见文字、input/control几何确认是否真实溢出或owner/CSS不同步；缺帧或只有恢复后帧时保持待验证，不登记产品bug。

状态：**READY / root已接线、尚无本次UI证据**。实际[静态preflight](logs/feature-inventory-composer-fit-preflight.json)重跑exit0：目标noEmit诊断0、lint错误警告0、两段rawJS parse通过且无`__name`helper；TSX实际导入后三个非精确context、六次hook调用的browser调用0、artifact目录无新增文件。该脚本只在`runtime/qa-composer-fit-static`写隔离HOME/cache/temp及本日志，不改bootstrap。

root接线后独立[hook preflight](logs/feature-inventory-composer-fit-hook-preflight.json)实际exit0：对当前CJS源码进行VM parse并使用真实导出的hook数组，beforeEach顺序为原hooks→reload→fit，afterEach为reload→fit→SPFV→原hooks；缺原beforeAll仍拒绝替换。仅调用fit的三个非匹配context、六次hook，browser/dynamic import/audit子进程/路径审查/文件读写计数均0。模块初始化只读取hook自身SHA一次，单独记录，不计入excluded调用。JSON包含当前hook和observer SHA；此检查没有执行bootstrap、reload或匹配目标的UI。

root接线调用`beginComposerFitObservation(this)`和`finishComposerFitObservation(this, {artifacts, observerSourceSha256, hookSourceSha256})`，传现有guard检查后的artifact根；observer再验证其与`ZCODE_E2E_ARTIFACT_DIR`一致、祖先非重解析且真实路径仍在工作树。写history失败/缺失独立记observationError并抛出，不作产品布局证据。
