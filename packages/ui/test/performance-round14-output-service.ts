import { useServices } from "@/hooks/useServices.js";

// 仅替换 workspace 路由边界；真实输出 hook 与 attachment 握手仍在浏览器运行。
export function useZCodeAgentService() {
  return useServices().zcodeAgentService;
}
