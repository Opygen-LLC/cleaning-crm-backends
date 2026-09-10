import sharp from "sharp";
import heicConvert from "heic-convert";

const MAX_INPUT_PIXELS = 40_000_000;
const MIN_WEBP_QUALITY = 64;
const MIN_OUTPUT_DIMENSION = 480;

export interface OptimizeImageOptions {
  contentType: string;
  maxDimension: number;
  targetBytes: number;
  favicon?: boolean;
}

export interface OptimizedImage {
  buffer: Buffer;
  mimeType: "image/webp" | "image/png";
  width: number | null;
  height: number | null;
}

const isHeic = (contentType: string) => /image\/(heic|heif)/i.test(contentType);

async function normalizeHeic(input: Buffer, contentType: string): Promise<Buffer> {
  if (!isHeic(contentType)) return input;
  try {
    await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    return input;
  } catch {
    const converted = await heicConvert({ buffer: Uint8Array.from(input).buffer, format: "JPEG", quality: 0.92 });
    return Buffer.from(converted);
  }
}

async function encodeWebp(input: Buffer, maxDimension: number, quality: number): Promise<Buffer> {
  return sharp(input, { animated: true, limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
    .webp({ quality, effort: 5, smartSubsample: true })
    .toBuffer();
}

export async function optimizeImage(input: Buffer, options: OptimizeImageOptions): Promise<OptimizedImage> {
  const normalized = await normalizeHeic(input, options.contentType);
  const source = sharp(normalized, { animated: true, limitInputPixels: MAX_INPUT_PIXELS });
  const metadata = await source.metadata();

  if (!metadata.width || !metadata.height) throw new Error("Image dimensions could not be determined.");
  if (metadata.width * metadata.height > MAX_INPUT_PIXELS) throw new Error("Image dimensions exceed the safe processing limit.");

  if (options.favicon) {
    const buffer = await sharp(normalized, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: options.maxDimension, height: options.maxDimension, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    const resultMeta = await sharp(buffer).metadata();
    return { buffer, mimeType: "image/png", width: resultMeta.width ?? null, height: resultMeta.height ?? null };
  }

  // First preserve dimensions and reduce encoder quality only within a
  // visually-safe band. If a highly detailed image still misses the desired
  // byte budget, reduce dimensions gradually instead of forcing destructive
  // ultra-low quality. The target is intentionally a soft upper budget: image
  // readability/visual quality wins over a few extra KB.
  let dimension = options.maxDimension;
  let quality = 88;
  let buffer = await encodeWebp(normalized, dimension, quality);

  while (buffer.length > options.targetBytes && quality > MIN_WEBP_QUALITY) {
    quality = Math.max(MIN_WEBP_QUALITY, quality - 6);
    buffer = await encodeWebp(normalized, dimension, quality);
  }

  while (buffer.length > options.targetBytes && dimension > MIN_OUTPUT_DIMENSION) {
    dimension = Math.max(MIN_OUTPUT_DIMENSION, Math.floor(dimension * 0.85));
    buffer = await encodeWebp(normalized, dimension, MIN_WEBP_QUALITY);
  }

  const resultMeta = await sharp(buffer).metadata();
  return { buffer, mimeType: "image/webp", width: resultMeta.width ?? null, height: resultMeta.height ?? null };
}
