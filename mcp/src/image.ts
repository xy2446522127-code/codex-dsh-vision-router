import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Jimp } from "jimp";

export const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"] as const;

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

/** GLM API 建议图片小于 10MB */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 超过该体积的本地图片先压缩再上传（减小传输与模型推理耗时） */
const COMPRESS_THRESHOLD_BYTES = 512 * 1024;
/** 压缩后最长边上限 */
const MAX_EDGE_PX = 1280;
/** JPEG 压缩质量 */
const COMPRESS_QUALITY = 85;

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export async function resolveImageUrl(image: string): Promise<string> {
  if (isHttpUrl(image)) {
    return image;
  }

  const ext = path.extname(image).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
    throw new Error(
      `不支持的图片格式：${ext || "(无扩展名)"}。仅支持 ${ALLOWED_EXTENSIONS.join(" / ")}`,
    );
  }

  let info;
  try {
    info = await stat(image);
  } catch {
    throw new Error(`找不到本地图片文件：${image}`);
  }
  if (!info.isFile()) {
    throw new Error(`路径不是文件：${image}`);
  }
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `图片过大（${(info.size / 1024 / 1024).toFixed(1)}MB），GLM API 要求 ≤10MB`,
    );
  }

  const data = await readFile(image);

  if (info.size > COMPRESS_THRESHOLD_BYTES) {
    return compressToDataUrl(data, ext);
  }
  return `data:${MIME_TYPES[ext]};base64,${data.toString("base64")}`;
}

async function compressToDataUrl(data: Buffer, ext: string): Promise<string> {
  let image;
  try {
    image = await Jimp.fromBuffer(data);
  } catch {
    return `data:${MIME_TYPES[ext]};base64,${data.toString("base64")}`;
  }
  const { width, height } = image.bitmap;
  if (width > MAX_EDGE_PX || height > MAX_EDGE_PX) {
    image.resize({
      w: width >= height ? MAX_EDGE_PX : Math.round((MAX_EDGE_PX * width) / height),
      h: height >= width ? MAX_EDGE_PX : Math.round((MAX_EDGE_PX * height) / width),
    });
  }
  const buffer = await image.getBuffer("image/jpeg", { quality: COMPRESS_QUALITY });
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}
