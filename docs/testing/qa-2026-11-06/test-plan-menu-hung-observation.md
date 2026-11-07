# menu-reviewed超时现场两次只读CIM采样计划

2026-11-07（Asia/Shanghai）主任务临时授权：RLM03标记未读后协议连续超时，立即补两次CIM进程观察，间隔约2秒。固定唯一run `qa-menu-20261106-menu-reviewed`；不修改原GRP sampler边界。

先审查所有写入env、runtime、HOME、staged app、既有perf和输出路径的祖先，拒绝工作树外/重解析点。唯一main必须同时匹配本树Electron executable、完整`--zcode-e2e-run-id`、本run完整HOME和`--app=.../main/index.js`，没有child type；还必须与worker0-1既有perf的mainPid25980相同，以免把后续SLM worker当作挂起现场。无main、多个main、创建时间或worker身份无法证明一律拒绝选取，不输出其它进程资源。

两次PS7 `Get-CimInstance Win32_Process`为只读，完整系统command/executable仅在内存验证。通过main身份后固定PID+创建时间；后代仅由PPID与父子创建时间链选取，不早于父进程。只保存PID、创建时间、角色、CPUticks/两点差值、workingSet、marker布尔。Host角色从同worker既有perf名字读取；无证据utility保持未分类。两次观察之间延迟约2秒，WMI开销另外记录。

无UI、CDP、attach、kill、用户目录写入、timeout/helper/同步修改。仅`logs/validation-menu-hung-cim-<timestamp>.json`独占落盘；identity拒绝也记录真实原因，不能据其它worker数据补造挂起CPU。隔离入口：`node .run-logs/qa-2026-11-06/validation/run-validation.mjs menu-hung-cim`。这不是额外产品test或UIcase。
