import { z } from "zod";
import type { CapabilityGrant, ExtensionProtocolName } from "#src/extension-host/grants.js";

export interface CapabilityDef {
  kind: "call" | "subscribe";
  /** 入参 schema；没有入参用 z.undefined()。 */
  input: z.ZodType;
  /** call 的返回，或 subscribe 的事件。 */
  output: z.ZodType;
  /** §3.5 的三块后端。 */
  backend: "service" | "pump" | "renderer";
  /**
   * 需要的档位（§17.3）。none 不需要授权；其余档位要清单声明（否则 not-declared）且用户授予
   * （否则 not-granted）。write 包含 read。
   */
  grant: CapabilityGrant;
  /** 返回值属于哪个稳定投影（§17.6）。清单声明的版本对不上时报 incompatible。 */
  protocol?: ExtensionProtocolName;
  /**
   * 入参带必填的 `requestId`（幂等键，§17.2）。ctx 的类型把它改成可选，扩展进程的通用包装在插件没传时
   * 补 randomUUID()；按这个标记处理，不按能力名分支。
   */
  requestIdentity?: true;
}
