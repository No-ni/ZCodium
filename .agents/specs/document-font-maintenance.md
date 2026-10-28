# 文档插件字体与发布维护边界

## 字体产品规则

DOCX、PDF、XLSX 的环境检查只检测已有本地字体，不自动下载、安装、注册字体，不创建字体目录或安装标记，不要求旧 `font_list.txt` 的整个目录清单齐全。旧清单仅保留为字体名称参考，不作为网络资源或必装依赖。没有合适字体时明确警告；生成任务按所需语言选择替代字体或说明缺失，不声称已经安装。

Windows 检查系统 Fonts 与用户 Fonts；macOS 检查用户、Library 和 System 字体目录；通用 CLI 的 Linux 脚本检查现有用户/系统字体及可用的 fontconfig。Linux 脚本支持不表示本仓构建 Linux Desktop 或嵌入 Linux 运行资源。识别 Noto、微软雅黑、宋体、苹方等已有 CJK 字体，不只认一个 CDN 文件名。

保持现有 `FONT_DIR` / `DOCX_FONTS_DIR` / `PDF_FONTS_DIR` / `XLSX_FONTS_DIR` 接口，指向实际存在的本地字体目录（优先已有用户字体，缺失时使用系统目录）。不新增资源端点环境变量或自动源回退；如确需安装，用户另行选择可信来源、确认许可证并明确授权，环境检查不执行该安装。Python/Node 等既有依赖检查不在本次字体改动范围。

## 所有者与事件顺序

环境脚本只拥有一次检查的临时结果；字体安装及系统注册由用户/系统管理器拥有。检查目录和 CJK 可用性，然后输出位置和缺失警告，不写入另一安装事实。业务生成、渲染和视觉验收保持既有消费者与流程。

## 许可与版本

四个文档插件的 `SKILL.md` 许可元数据与各自 Apache-2.0 `LICENSE.txt` 一致，保留 Z.ai 版权和第三方声明。修改随包插件能力时递增各插件 patch 版本，同步 package、manifest 和本地 seed 定义；不改产品根版本，不注册、安装或发布市场。

## 发布工具

release-it 的默认 Git push 关闭，显式启用 push 时目标仅为 `origin`；提交与 tag 注释使用中文。版本、commit、tag 和 push 仍需用户授权，本次不运行 release-it、不提交、不推送、不构建。GitHub Desktop 工作流只由 `workflow_dispatch` 手动触发，提供 Windows/macOS 的 x64/arm64 Actions 产物，不自动创建 Release。

## 验收

- 六个环境脚本不含默认官方字体 CDN、字体下载、注册和安装标记逻辑；文档不再给出旧 CDN 下载命令。
- 使用隔离临时目录及模拟平台运行字体检查片段，证明无网络/写入、可识别系统 CJK、缺字体只警告、不要求整个清单；完整依赖安装脚本不在测试中执行。
- PowerShell 7 解析三个 Windows 脚本，Bash 语法检查 POSIX 脚本；未验证真机字体渲染/安装必须明确说明。
- 插件三处版本一致、许可元数据正确；release 配置禁止默认 push 且显式目标为 origin。
