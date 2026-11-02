import { Cron } from "croner";

/** 校验 cron 表达式是否合法（5 段，本地时区）。 */
export function isValidCronExpr(cronExpr: string): boolean {
  try {
    // croner 构造时即解析，非法表达式会抛错。
    new Cron(cronExpr);
    return true;
  } catch {
    return false;
  }
}

// 规则可行性与错误类身份由唯一领域验证器维护。
export {
  assertValidAutomationScheduleRule,
  InvalidAutomationScheduleRuleError,
} from "./automationScheduleValidation.js";
