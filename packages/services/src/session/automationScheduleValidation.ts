import type { ZCodeAutomationScheduleRule } from "@zcode/shared";

/** 非法自定义调度规则；规则必须先通过领域校验才能写入内部任务库。 */
export class InvalidAutomationScheduleRuleError extends Error {
  constructor(message: string) {
    super(`非法的定时任务调度规则：${message}`);
    this.name = "InvalidAutomationScheduleRuleError";
  }
}

const MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL = 1_200;
const AUTOMATION_SCHEDULE_RULE_UNITS = new Set([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

function hasOnlyIntegersInRange(values: number[] | undefined, min: number, max: number): boolean {
  return Boolean(
    values?.length &&
    values.every((value) => Number.isInteger(value) && value >= min && value <= max),
  );
}

/** 非法相对时间定时任务；相对延迟只用于一次性任务，并由服务端真实时钟生成调度规则。 */
export class InvalidAutomationRelativeDelayError extends Error {
  constructor(message: string) {
    super(`非法的相对时间定时任务：${message}`);
    this.name = "InvalidAutomationRelativeDelayError";
  }
}

/**
 * create 期相对延迟（delayMinutes）入参校验：范围、一次性语义与互斥约束。
 * 归入调度入参校验族，与 scheduleRule 校验共同构成持久化前的领域防线。
 */
export function assertValidAutomationRelativeDelayParams(params: {
  relativeDelayMinutes?: number;
  recurring?: boolean;
  maxRuns?: number | null;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
}): void {
  const { relativeDelayMinutes } = params;
  if (
    relativeDelayMinutes !== undefined &&
    (!Number.isInteger(relativeDelayMinutes) ||
      relativeDelayMinutes < 1 ||
      relativeDelayMinutes > 525_600)
  ) {
    throw new InvalidAutomationRelativeDelayError("delayMinutes 必须是 1-525600 的整数");
  }
  if (relativeDelayMinutes !== undefined && params.recurring) {
    throw new InvalidAutomationRelativeDelayError("相对延迟任务必须设置 recurring=false");
  }
  if (relativeDelayMinutes !== undefined && params.maxRuns !== undefined) {
    throw new InvalidAutomationRelativeDelayError("相对延迟任务固定只运行一次，不能设置 maxRuns");
  }
  if (relativeDelayMinutes !== undefined && params.scheduleRule) {
    throw new InvalidAutomationRelativeDelayError("不能同时提交 delayMinutes 和 scheduleRule");
  }
}

/**
 * 自定义重复规则的领域校验：调度引擎（automationCron.computeScheduleRuleNextRunAt）之外的
 * 唯一持久化防线。AutomationService 在归一化/重锚定后调用，保证与引擎解析一致。
 */
export function assertValidAutomationScheduleRule(rule: ZCodeAutomationScheduleRule): void {
  if (!AUTOMATION_SCHEDULE_RULE_UNITS.has(rule.unit)) {
    throw new InvalidAutomationScheduleRuleError("unit 不受支持");
  }
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new InvalidAutomationScheduleRuleError("interval 必须是正整数");
  }
  if (rule.unit === "monthly" && rule.interval > MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL) {
    throw new InvalidAutomationScheduleRuleError(
      `monthly interval 不能超过 ${MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL}`,
    );
  }
  if (!Number.isInteger(rule.hour) || rule.hour < 0 || rule.hour > 23) {
    throw new InvalidAutomationScheduleRuleError("hour 必须是 0-23 的整数");
  }
  if (!Number.isInteger(rule.minute) || rule.minute < 0 || rule.minute > 59) {
    throw new InvalidAutomationScheduleRuleError("minute 必须是 0-59 的整数");
  }
  if (
    rule.monthlyMode !== undefined &&
    rule.monthlyMode !== "date" &&
    rule.monthlyMode !== "weekday"
  ) {
    throw new InvalidAutomationScheduleRuleError("monthlyMode 不受支持");
  }
  if (rule.weekdays && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekdays 必须是 0-6 的非空整数数组");
  }
  if (rule.unit === "weekly" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekly 规则必须包含有效的 weekdays");
  }
  if (rule.unit === "monthly") {
    if (rule.monthlyMode === "weekday" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
      throw new InvalidAutomationScheduleRuleError("monthly weekday 规则必须包含有效的 weekdays");
    }
    if (rule.monthlyMode !== "weekday" && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
      throw new InvalidAutomationScheduleRuleError("monthly date 规则必须包含有效的 monthDays");
    }
  }
  if (rule.months && !hasOnlyIntegersInRange(rule.months, 1, 12)) {
    throw new InvalidAutomationScheduleRuleError("months 必须是 1-12 的非空整数数组");
  }
  if (rule.monthDays && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
    throw new InvalidAutomationScheduleRuleError("monthDays 必须是 1-31 的非空整数数组");
  }
  if (rule.unit === "yearly") {
    // 窄口径可行性校验（docs/specs/automation-lifecycle-controls.md「调度规则可行性校验」）：
    // yearly 只按 months[0]（缺省回退 anchorAt 月份）与 monthDays[0]（缺省回退 anchor 日）调度；
    // 解析后的 (月, 日) 对在所有年份都不存在时（2 月 ≥30 日、4/6/9/11 月 31 日），
    // computeScheduleRuleNextRunAt 恒为 null，任务会以 active+next_run_at=null 永不被认领、
    // 永不终态，用户编辑 endAt/maxRuns 也救不回。与引擎解析保持一致，在写库前拒绝。
    // Feb 29 闰年存在，不拒绝（引擎逐 year 溢出守卫维持原语义）；monthly 引擎按月遍历并跳过
    // 溢出日（months 不参与 monthly），任何 1-31 都能命中长月，不做本校验以防错拒。
    // months 多值仅首项参与调度（引擎现状）：可行性只看 months[0]，多值支持属未定设计，仅记录。
    const anchor = new Date(rule.anchorAt);
    const targetMonth =
      rule.months?.[0] != null ? (((rule.months[0] - 1) % 12) + 12) % 12 : anchor.getMonth();
    const targetDay = rule.monthDays?.[0] ?? anchor.getDate();
    const impossible =
      (targetMonth === 1 && targetDay >= 30) ||
      (targetDay >= 31 &&
        (targetMonth === 3 || targetMonth === 5 || targetMonth === 8 || targetMonth === 10));
    if (impossible) {
      throw new InvalidAutomationScheduleRuleError(
        "yearly 规则选中的月日（含 anchor 回退）在所有年份都不存在（如 2 月 30 日或 4/6/9/11 月 31 日），任务将永不执行",
      );
    }
  }
}
