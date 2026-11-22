/** 首次使用证据的只读 adapter。CLI 会话事实不由 Host 生成；环境与用户配置只按既有可确定镜像规则读取，相对路径未知，读取失败不等于无使用记录。本仓默认路径与 CLI 同根。 */
export type OnboardingLocalUsageEntry = typeof import("../localUsageEvidence.js");
