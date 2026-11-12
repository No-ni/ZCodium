import { Jimp, JimpMime, ResizeStrategy } from "jimp";
import { createImageProcessorError, type ImageCompressionStrategy } from "@zcode/contracts";
import { throwIfAborted } from "../jimp-media.js";
import type { NativeImagePolicy } from "./image-policy.js";

export type NativeJimpImage = Awaited<ReturnType<typeof Jimp.read>>;
export interface NativeImageCandidate {
  data: Buffer;
  mediaType: string;
  width: number;
  height: number;
  strategy: ImageCompressionStrategy;
  quality?: number;
}

export async function decodeNativeImage(
  input: Buffer,
  signal?: AbortSignal,
): Promise<NativeJimpImage> {
  throwIfAborted(signal);
  let image: NativeJimpImage;
  try {
    image = await Jimp.read(input);
  } catch (cause) {
    throw createImageProcessorError({
      code: "processing_failed",
      message: "Unable to decode image data",
      cause,
    });
  }
  throwIfAborted(signal);
  return image;
}

export function prepareNativeAlpha(
  image: NativeJimpImage,
  policy: NativeImagePolicy,
): NativeJimpImage {
  const clone = image.clone();
  if (policy.alphaMode !== "flatten") return clone;
  const rgb = Number.parseInt(policy.flattenColor.slice(1), 16);
  const background = [(rgb >>> 16) & 255, (rgb >>> 8) & 255, rgb & 255];
  for (let offset = 0; offset < clone.bitmap.data.length; offset += 4) {
    const alpha = clone.bitmap.data[offset + 3]! / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      clone.bitmap.data[offset + channel] = Math.round(
        clone.bitmap.data[offset + channel]! * alpha + background[channel]! * (1 - alpha),
      );
    }
    clone.bitmap.data[offset + 3] = 255;
  }
  return clone;
}

export function resizeNativeImage(image: NativeJimpImage, edge: number): NativeJimpImage {
  const clone = image.clone();
  const longest = Math.max(image.bitmap.width, image.bitmap.height);
  if (longest <= edge) return clone;
  const factor = edge / longest;
  clone.resize({
    w: Math.max(1, Math.round(image.bitmap.width * factor)),
    h: Math.max(1, Math.round(image.bitmap.height * factor)),
    mode: ResizeStrategy.BICUBIC,
  });
  return clone;
}

export async function* encodeNativeImageCandidates(
  image: NativeJimpImage,
  sourceMediaType: string,
  policy: NativeImagePolicy,
  resized: boolean,
  signal?: AbortSignal,
): AsyncGenerator<NativeImageCandidate> {
  if (sourceMediaType !== "image/jpeg") {
    const data = await encodeBuffer(
      () => image.getBuffer(JimpMime.png, { deflateLevel: 9, deflateStrategy: 3 }),
      signal,
    );
    yield {
      data,
      mediaType: JimpMime.png,
      strategy: resized ? "resized" : "png-optimized",
      width: image.bitmap.width,
      height: image.bitmap.height,
    };
    if (policy.pngMode !== "jpeg-if-opaque" || !isOpaque(image)) return;
  }
  for (const quality of jpegQualities(policy.jpegQuality, policy.minJpegQuality)) {
    const data = await encodeBuffer(() => image.getBuffer(JimpMime.jpeg, { quality }), signal);
    yield {
      data,
      mediaType: JimpMime.jpeg,
      strategy: sourceMediaType === "image/jpeg" ? "jpeg-quality" : "jpeg-fallback",
      width: image.bitmap.width,
      height: image.bitmap.height,
      quality,
    };
  }
}

function jpegQualities(target: number, minimum: number): number[] {
  const values = [target];
  for (let quality = target - 10; quality > minimum; quality -= 10) values.push(quality);
  if (minimum !== target) values.push(minimum);
  return values;
}

function isOpaque(image: NativeJimpImage): boolean {
  for (let offset = 3; offset < image.bitmap.data.length; offset += 4) {
    if (image.bitmap.data[offset] !== 255) return false;
  }
  return true;
}

async function encodeBuffer(encode: () => Promise<Buffer>, signal?: AbortSignal): Promise<Buffer> {
  throwIfAborted(signal);
  let data: Buffer;
  try {
    data = await encode();
  } catch (cause) {
    throw createImageProcessorError({
      code: "processing_failed",
      message: "Unable to encode image data",
      cause,
    });
  }
  throwIfAborted(signal);
  return data;
}
