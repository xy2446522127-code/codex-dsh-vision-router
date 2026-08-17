import { readFile } from "node:fs/promises";
import { Jimp } from "jimp";

import { isHttpUrl } from "./image.js";

/** 九宫格区域名（full 表示不裁剪） */
export const REGION_NAMES = [
  "full",
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

export type RegionName = (typeof REGION_NAMES)[number];

const GRID_CELLS: Record<Exclude<RegionName, "full">, { col: number; row: number }> = {
  "top-left": { col: 0, row: 0 },
  "top-center": { col: 1, row: 0 },
  "top-right": { col: 2, row: 0 },
  "middle-left": { col: 0, row: 1 },
  "middle-center": { col: 1, row: 1 },
  "middle-right": { col: 2, row: 1 },
  "bottom-left": { col: 0, row: 2 },
  "bottom-center": { col: 1, row: 2 },
  "bottom-right": { col: 2, row: 2 },
};

export function isRegionName(value: string): value is RegionName {
  return (REGION_NAMES as readonly string[]).includes(value);
}

interface RawRect {
  nums: number[];
  pcts: boolean[];
}

/** 解析 "x,y,w,h"，支持像素或百分比（如 "10%,20%,40%,30%"）。不合法返回 null */
export function parseRect(value: string): RawRect | null {
  const parts = value.split(",").map((p) => p.trim());
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  const pcts: boolean[] = [];
  for (const part of parts) {
    const m = /^(-?\d+(?:\.\d+)?)(%?)$/.exec(part);
    if (!m) {
      return null;
    }
    nums.push(Number(m[1]));
    pcts.push(m[2] === "%");
  }
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
    return null;
  }
  return { nums, pcts };
}

function clampRect(
  raw: RawRect,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const [rx, ry, rw, rh] = raw.nums;
  const [px, py, pw, ph] = raw.pcts;
  let x = px ? (rx / 100) * width : rx;
  let y = py ? (ry / 100) * height : ry;
  const w = pw ? (rw / 100) * width : rw;
  const h = ph ? (rh / 100) * height : rh;
  if (w <= 0 || h <= 0) {
    throw new Error(`裁剪区域宽高必须大于 0（region: "${raw.nums.join(",")}"）`);
  }
  x = Math.max(0, Math.min(x, width - 1));
  y = Math.max(0, Math.min(y, height - 1));
  const cw = Math.min(w, width - x);
  const ch = Math.min(h, height - y);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(cw), h: Math.round(ch) };
}

async function readImageBuffer(image: string): Promise<Buffer> {
  if (isHttpUrl(image)) {
    const res = await fetch(image);
    if (!res.ok) {
      throw new Error(`下载图片失败（HTTP ${res.status}）：${image}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  return readFile(image);
}

/**
 * 按 region 裁剪图片（本地路径或 URL），返回裁剪后的 data URI 与区域标签。
 * region 支持：九宫格名称（如 "top-right"）或 "x,y,w,h"（像素/百分比，如 "10%,20%,40%,30%"）。
 * "full"（或不传）返回原图 data URI，不裁剪。
 */
export async function resolveCroppedImageUrl(
  image: string,
  region: string,
): Promise<{ dataUrl: string; regionLabel: string }> {
  if (!region || region.trim().toLowerCase() === "full") {
    return { dataUrl: image, regionLabel: "full" };
  }
  const regionValue = region.trim().toLowerCase();
  if (!isRegionName(regionValue) && !parseRect(regionValue)) {
    throw new Error(
      `无法识别的 region："${region}"。支持：${REGION_NAMES.join(" / ")}，或矩形 "x,y,w,h"（可用百分比，如 "10%,20%,40%,30%"）。`,
    );
  }

  const buffer = await readImageBuffer(image);
  const img = await Jimp.read(buffer);
  const { width, height } = img;

  let rect: { x: number; y: number; w: number; h: number };
  if (regionValue !== "full" && (REGION_NAMES as readonly string[]).includes(regionValue)) {
    const cell = GRID_CELLS[regionValue as Exclude<RegionName, "full">];
    const cellW = Math.floor(width / 3);
    const cellH = Math.floor(height / 3);
    rect = {
      x: cell.col * cellW,
      y: cell.row * cellH,
      w: cell.col === 2 ? width - 2 * cellW : cellW,
      h: cell.row === 2 ? height - 2 * cellH : cellH,
    };
  } else {
    rect = clampRect(parseRect(regionValue) as RawRect, width, height);
  }

  const cropped = img.crop({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  const out = await cropped.getBuffer("image/png");
  return {
    dataUrl: `data:image/png;base64,${out.toString("base64")}`,
    regionLabel: `${regionValue} (${rect.x},${rect.y},${rect.w},${rect.h}px)`,
  };
}
