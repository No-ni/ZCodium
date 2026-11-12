import { z } from "zod";
import {
  autoNumberField,
  booleanField,
  numberField,
  selectField,
  thresholdField,
} from "./field-descriptors.js";

export const nativeContextTriggerParametersSchema = z
  .object({
    start: thresholdField(["自动摘要触发", "Automatic summary trigger"], 70, false),
    target: thresholdField(["整理目标", "Compression target"], 50, true),
    growthTokens: numberField(
      "trigger",
      ["新增内容门槛（token）", "New-content threshold (tokens)"],
      50000,
      { min: 1 },
    ),
    checkIntervalRounds: numberField(
      "trigger",
      ["普通检查间隔（模型轮）", "Regular check interval (model rounds)"],
      5,
      { min: 1, max: 1000 },
    ),
    opportunisticPercent: numberField(
      "trigger",
      ["机会性检查最低占用（%）", "Minimum usage for opportunistic checks (%)"],
      45,
      { min: 0, max: 95, advanced: true },
    ),
    capacityPercent: numberField(
      "trigger",
      ["容量后备检查（%）", "Capacity fallback check (%)"],
      95,
      { min: 1, max: 100, advanced: true },
    ),
    growthMode: selectField(
      "trigger",
      ["增长算法", "Growth algorithm"],
      [
        ["constant", "固定门槛", "Constant threshold"],
        ["adaptive", "按预算自适应", "Adapt to input budget"],
      ],
      "constant",
      { advanced: true },
    ),
    tierGrowthTokens: z
      .object({
        t1: autoNumberField(
          "trigger",
          ["T1 增长门槛（token）", "T1 growth threshold (tokens)"],
          "auto",
          { min: 1, advanced: true },
        ),
        t2: autoNumberField(
          "trigger",
          ["T2 增长门槛（token）", "T2 growth threshold (tokens)"],
          "auto",
          { min: 1, advanced: true },
        ),
        t3: autoNumberField(
          "trigger",
          ["T3 增长门槛（token）", "T3 growth threshold (tokens)"],
          "auto",
          { min: 1, advanced: true },
        ),
      })
      .strict(),
    minBenefitTokens: autoNumberField(
      "trigger",
      ["最低可回收量（token）", "Minimum recoverable input (tokens)"],
      "auto",
      {
        min: 0,
        advanced: true,
        help: [
          "auto 按当前预算计算；0 仍要求净收益。",
          "Auto uses the current budget; zero still requires a positive net benefit.",
        ],
      },
    ),
    periodicCheckRounds: numberField(
      "trigger",
      ["周期补查间隔（模型轮）", "Periodic recheck interval (model rounds)"],
      15,
      { min: 0, max: 1000, advanced: true },
    ),
    waitForUsageSample: booleanField(
      "trigger",
      ["压力判断等待实际用量", "Wait for actual usage before pressure checks"],
      true,
      { advanced: true },
    ),
    estimateHoldRounds: numberField(
      "trigger",
      ["估算最多等待（轮）", "Maximum estimate hold (rounds)"],
      2,
      { min: 0, max: 20, advanced: true },
    ),
    modelDecides: booleanField(
      "trigger",
      ["让摘要模型判断机会性压缩", "Ask the summary model about opportunistic compression"],
      false,
      {
        advanced: true,
        help: ["开启会增加一次有界模型请求。", "Enabling this adds one bounded model request."],
      },
    ),
    decisionMaxOutputTokens: numberField(
      "trigger",
      ["判断输出预算（token）", "Decision output budget (tokens)"],
      200,
      { min: 32, max: 2048, advanced: true },
    ),
    adaptive: z
      .object({
        ratioPercent: numberField(
          "trigger",
          ["自适应预算比例（%）", "Adaptive budget ratio (%)"],
          5,
          { min: 0, max: 100, advanced: true },
        ),
        floorTokens: numberField(
          "trigger",
          ["自适应下界（token）", "Adaptive lower bound (tokens)"],
          50000,
          { min: 1, advanced: true },
        ),
        capTokens: numberField(
          "trigger",
          ["自适应上界（token）", "Adaptive upper bound (tokens)"],
          50000,
          { min: 1, advanced: true },
        ),
        minGrowthFloorTokens: numberField(
          "trigger",
          ["再次维护最低增长（token）", "Minimum growth before further maintenance (tokens)"],
          20000,
          { min: 0, advanced: true },
        ),
        minGrowthRatioPercent: numberField(
          "trigger",
          ["再次维护增长比例（%）", "Growth ratio before further maintenance (%)"],
          45,
          { min: 0, max: 100, advanced: true },
        ),
        tierMultiplier: numberField("trigger", ["层级增长倍率", "Tier growth multiplier"], 1.5, {
          min: 1,
          decimal: true,
          advanced: true,
        }),
      })
      .strict(),
  })
  .strict();
