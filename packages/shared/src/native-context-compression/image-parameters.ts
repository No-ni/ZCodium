import { z } from "zod";
import {
  autoNumberField,
  booleanField,
  describe,
  localize,
  numberField,
  selectField,
  textField,
} from "./field-descriptors.js";

export const nativeContextImageParametersSchema = z
  .object({
    rescale: booleanField("images", ["发送图片降采样", "Downsample images for sending"], true),
    foldWithHistory: booleanField(
      "images",
      ["旧图随合格历史折叠", "Fold older images with eligible history"],
      true,
    ),
    omitSeen: booleanField(
      "images",
      ["已提供图片减少重复携带", "Avoid resending images already provided"],
      false,
      {
        help: [
          "成功提供后可保留来源说明；当前上传和未完成轮仍保留图片。",
          "After successful delivery, retain a source reference. Current uploads and unfinished rounds still retain images.",
        ],
      },
    ),
    keepRecentUserTurns: numberField(
      "images",
      ["保留最近用户图片（轮）", "Preserve recent user images (rounds)"],
      1,
      {
        min: 1,
        max: 100,
        advanced: true,
        help: [
          "可扩大保留范围；当前上传的图片始终保留。",
          "Expand the preservation range; the latest uploaded images are always retained.",
        ],
      },
    ),
    convention: z
      .object({
        enabled: booleanField(
          "images",
          ["提示模型写下看图结论", "Ask the model to record image findings"],
          true,
        ),
        text: textField("images", ["图像使用指导", "Image usage guidance"], "", {
          advanced: true,
          multiline: true,
          maxLength: 8000,
          help: [
            "留空使用内置指导；仍按需要看图，保留原图读取入口。",
            "Leave empty for built-in guidance. Inspect images as needed and keep original-image retrieval available.",
          ],
        }),
      })
      .strict(),
    maxEdge: numberField("images", ["最长边（px）", "Maximum edge (px)"], 1600, {
      min: 128,
      max: 8192,
    }),
    jpegQuality: numberField("images", ["JPEG 目标质量", "Target JPEG quality"], 80, {
      min: 1,
      max: 100,
    }),
    minJpegQuality: numberField("images", ["JPEG 最低质量", "Minimum JPEG quality"], 60, {
      min: 1,
      max: 100,
      advanced: true,
    }),
    minEdge: numberField(
      "images",
      ["继续降采样的最小长边（px）", "Minimum edge for further downsampling (px)"],
      512,
      { min: 128, max: 8192, advanced: true },
    ),
    minReductionPercent: numberField(
      "images",
      ["采用副本的最低字节收益（%）", "Minimum byte reduction for using a copy (%)"],
      20,
      { min: 0, max: 99 },
    ),
    triggerMode: selectField(
      "images",
      ["降采样触发方式", "Downsampling trigger"],
      [
        ["edge", "边长超限", "Edge limit exceeded"],
        ["edge-or-bytes", "边长或字节超限", "Edge or byte limit exceeded"],
      ],
      "edge",
    ),
    byteTriggerKiB: numberField("images", ["字节触发（KiB）", "Byte trigger (KiB)"], 100, {
      min: 0,
      max: 20480,
      advanced: true,
    }),
    pngMode: selectField(
      "images",
      ["PNG 发送策略", "PNG sending policy"],
      [
        ["preserve", "保留 PNG", "Preserve PNG"],
        ["jpeg-if-opaque", "不透明时可转 JPEG", "Convert opaque images to JPEG"],
      ],
      "preserve",
      { advanced: true },
    ),
    alphaMode: selectField(
      "images",
      ["透明度", "Transparency"],
      [
        ["preserve", "保留透明度", "Preserve transparency"],
        ["flatten", "使用固定底色", "Use a fixed background color"],
      ],
      "preserve",
      { advanced: true },
    ),
    flattenColor: describe(
      z.string().regex(/^#[a-f0-9]{6}$/i),
      "images",
      "text",
      ["透明图固定底色（RGB hex）", "Fixed background for transparent images (RGB hex)"],
      "#ffffff",
      {
        advanced: true,
        maxLength: 7,
        help: [
          "使用 #RRGGBB；仅固定底色模式生效，不跟随界面主题。",
          "Use #RRGGBB. Applies only when flattening transparency and never follows the UI theme.",
        ],
      },
    ),
    targetRawKiB: autoNumberField(
      "images",
      ["单图发送目标（KiB）", "Per-image sending target (KiB)"],
      "auto",
      {
        min: 16,
        advanced: true,
        help: [
          "auto 沿用已有预算；不能超过目标硬限制。",
          "Auto uses the existing budget; the target must not exceed the provider's hard limit.",
        ],
      },
    ),
    sourceKinds: describe(
      z
        .array(z.enum(["attachment", "read", "bash", "mcp"]))
        .max(4)
        .refine((sources) => new Set(sources).size === sources.length, {
          message: "Image source kinds must be unique.",
        }),
      "images",
      "list",
      ["处理图片来源", "Image sources to process"],
      ["attachment", "read", "bash", "mcp"],
      {
        advanced: true,
        maxItems: 4,
        options: [
          ["attachment", "用户附件"],
          ["read", "读取工具"],
          ["bash", "命令工具"],
          ["mcp", "MCP 工具"],
        ],
        optionLabels: {
          attachment: localize(["用户附件", "User attachments"]),
          read: localize(["读取工具", "Read tools"]),
          bash: localize(["命令工具", "Command tools"]),
          mcp: localize(["MCP 工具", "MCP tools"]),
        },
        help: [
          "attachment / read / bash / mcp；不含仅展示的截图。",
          "attachment / read / bash / mcp; excludes screenshots used only for display.",
        ],
      },
    ),
    cacheMaxEntries: numberField(
      "images",
      ["副本缓存上限（张）", "Maximum cached copies (images)"],
      512,
      { min: 0, max: 4096, advanced: true },
    ),
    cacheMaxMiB: numberField("images", ["副本缓存上限（MiB）", "Maximum copy cache (MiB)"], 64, {
      min: 0,
      max: 256,
      advanced: true,
    }),
  })
  .strict();
