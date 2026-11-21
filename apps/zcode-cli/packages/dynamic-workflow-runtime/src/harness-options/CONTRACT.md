# cli-workflow-harness-options

定义调用现有工作流子进程宿主所需的选项与回调类型。只提供类型，未实现宿主、
创建引擎或启动子进程；依赖既有 CLI 工作流引擎的类型。

- RunWorkflowOptions 的字段与可选性保持；script/lowered、launch、args、resume cache
  仍由调用方建立一致性，宿主按既有契约透传。
- DriverFactory 接收同一宿主的回报 sink。RunControlBinding 只接收现有引擎的
  setMaxConcurrency/fillHole/openHoles/filledHoles，不新增控制面或 run 裁决者。
- HarnessWarning 保留既有 DTO，仅作为调用边界；本模块不执行文件 IO 或日志记录。
- 原 harness、child-entry-file 与 package 公开入口再导出这些类型，消费路径兼容。

交接顺序仍是调用方选项 → 原 harness → 同一 WorkflowEngine / child → 原 settlement。
类型模块不参与 admission、first-wins cleanup、stdio 顺序或持久化时序。
