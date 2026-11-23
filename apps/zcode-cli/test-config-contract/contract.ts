/** CLI 测试配置只由现有 Vitest runner 读取；Node test 入口保持独立，不装配业务运行时。 */
export type CliTestConfiguration = typeof import("../vitest.config.js").default;
