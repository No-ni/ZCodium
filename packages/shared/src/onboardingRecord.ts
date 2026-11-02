import { z } from "zod";

/**
 * Onboarding 完成记录（三步向导：职业 / 模式 / 偏好）。
 *
 * 设计约束：
 * - 独立本地 JSON（~/.zcodium/v2/onboarding-record.json），不混入 AppSettings；
 * - 跳过是显式答案：某页被跳过时该字段记 null，与"明确选择了值"区分。
 */

/** occupation 用非空字符串而非枚举：职业列表会演进，旧记录不能因枚举收窄而校验失败。 */
export const onboardingOccupationSchema = z.string().min(1).nullable();

export const onboardingInterfaceModeSchema = z.enum(["coding", "office"]).nullable();

export const onboardingRecordEntrySchema = z.object({
  occupation: onboardingOccupationSchema,
  interfaceMode: onboardingInterfaceModeSchema,
  memoryEnabled: z.boolean().nullable(),
  proactiveSuggestionsEnabled: z.boolean().nullable(),
  completedAt: z.string().min(1),
});

export const onboardingDecisionSchema = z.object({
  userId: z.string().min(1).nullable(),
  status: z.enum(["dismissed", "existing_local_user"]),
  reason: z.enum(["user_closed", "existing_local_task"]),
  decidedAt: z.string().min(1),
});

const onboardingRecordFileV1Schema = z.object({
  version: z.literal(1),
  entries: z.array(onboardingRecordEntrySchema),
});

const onboardingRecordFileV2Schema = z.object({
  version: z.literal(2),
  deviceMid: z.string().min(1),
  entries: z.array(onboardingRecordEntrySchema),
  decisions: z.array(onboardingDecisionSchema),
});

/** 历史 v1/v2 只投影本地答案；写回统一为 v1，不再生成账号或设备档案。 */
export const onboardingRecordFileSchema = z
  .union([onboardingRecordFileV1Schema, onboardingRecordFileV2Schema])
  .transform((file) => ({ version: 1 as const, entries: file.entries }));

export type OnboardingRecordEntry = z.infer<typeof onboardingRecordEntrySchema>;
export type OnboardingDecision = z.infer<typeof onboardingDecisionSchema>;

/** 仅包含用户显式选择的本地偏好。 */
export type OnboardingRecordEntryInput = OnboardingRecordEntry;

export type OnboardingRecordFile = z.infer<typeof onboardingRecordFileSchema>;
