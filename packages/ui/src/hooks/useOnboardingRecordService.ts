import { useOptionalServices } from "./useServices.js";

/**
 * Onboarding 完成记录服务（仅本地持久化）。
 * 旧测试 double / 不支持的 host 未注册该服务时返回 null，调用方需判空降级。
 * 无 ServiceProvider 的纯渲染测试（该服务与被测行为无关）也返回 null 而不是抛错——
 * 使用同一 Context 的可选入口，每次渲染先固定调用 Hook，再处理缺服务或 getter 故障。
 */
export function useOnboardingRecordService() {
  const services = useOptionalServices();
  try {
    return services?.onboardingRecordService ?? null;
  } catch {
    return null;
  }
}
