// vision_tools.ts — dsh-vision-router 核心能力在 Codex MCP 侧的实现
// 新增工具：vision_ground / vision_detect / vision_pixel_diff /
//           vision_html_screenshot / vision_colors / vision_bootstrap
// 本地图像处理: jimp；HTML 渲染: 系统 Chrome/Edge headless；视觉: 环境变量配置的视觉模型
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Jimp } from "jimp";
import { resolveImageUrl, isHttpUrl } from "./image.js";

const execFileAsync = promisify(execFile);
type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VISION_API_URL =
  process.env.VISION_API_URL ||
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const VISION_MODEL = process.env.VISION_MODEL || "qwen3.7-flash";
const API_KEY =
  process.env.QIANWEN_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.ZHIPU_API_KEY || "";
const OUTPUT_DIR = process.env.VISION_OUTPUT_DIR || path.join(__dirname, "..", "output");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureOutputDir(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
}

async function loadImage(image: string): Promise<JimpImage> {
  if (isHttpUrl(image)) {
    const res = await fetch(image);
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
    return Jimp.read(Buffer.from(await res.arrayBuffer()));
  }
  return Jimp.read(image);
}

async function callVision(imageDataUrl: string, prompt: string, maxTokens = 1200): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(3000 * attempt);
    try {
      const res = await fetch(VISION_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model: VISION_MODEL,
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: imageDataUrl } },
                { type: "text", text: prompt },
              ],
            },
          ],
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const raw = await res.text();
      if (res.status === 429 && attempt < 2) {
        lastError = new Error(`限流 429: ${raw.slice(0, 200)}`);
        continue;
      }
      if (!res.ok) throw new Error(`视觉模型 API ${res.status}: ${raw.slice(0, 300)}`);
      const j = JSON.parse(raw);
      const t = j?.choices?.[0]?.message?.content;
      if (typeof t !== "string" || !t.trim()) throw new Error("视觉模型未返回内容");
      return t.trim();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error("视觉模型调用失败");
}

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.search(/[[{]/);
  if (start < 0) throw new Error("模型未返回 JSON：" + t.slice(0, 200));
  const end = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
  return JSON.parse(t.slice(start, end + 1));
}

async function savePng(prefix: string, img: JimpImage): Promise<string> {
  await ensureOutputDir();
  const p = path.join(OUTPUT_DIR, `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
  await img.write(p as `${string}.${string}`);
  return p;
}

function drawBox(
  img: JimpImage,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: [number, number, number],
  width = 3,
): void {
  const W = img.bitmap.width;
  const H = img.bitmap.height;
  const X1 = Math.max(0, Math.round(x1));
  const Y1 = Math.max(0, Math.round(y1));
  const X2 = Math.min(W - 1, Math.round(x2));
  const Y2 = Math.min(H - 1, Math.round(y2));
  const setPx = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const idx = (y * W + x) * 4;
    img.bitmap.data[idx] = color[0];
    img.bitmap.data[idx + 1] = color[1];
    img.bitmap.data[idx + 2] = color[2];
    img.bitmap.data[idx + 3] = 255;
  };
  for (let x = X1; x <= X2; x++) {
    for (let w = 0; w < width; w++) {
      setPx(x, Y1 + w);
      setPx(x, Y2 - w);
    }
  }
  for (let y = Y1; y <= Y2; y++) {
    for (let w = 0; w < width; w++) {
      setPx(X1 + w, y);
      setPx(X2 - w, y);
    }
  }
}

interface PreparedImage {
  dataUrl: string;
  origW: number;
  origH: number;
  sentW: number;
  sentH: number;
}

async function prepareImage(image: string): Promise<PreparedImage> {
  if (isHttpUrl(image)) {
    const res = await fetch(image);
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const img = await Jimp.read(buf);
    return {
      dataUrl: `data:image/png;base64,${buf.toString("base64")}`,
      origW: img.bitmap.width,
      origH: img.bitmap.height,
      sentW: img.bitmap.width,
      sentH: img.bitmap.height,
    };
  }
  const orig = await loadImage(image);
  const dataUrl = await resolveImageUrl(image);
  const sent = dataUrl.startsWith("data:")
    ? await Jimp.read(Buffer.from(dataUrl.split(",")[1] || "", "base64"))
    : orig;
  return {
    dataUrl,
    origW: orig.bitmap.width,
    origH: orig.bitmap.height,
    sentW: sent.bitmap.width,
    sentH: sent.bitmap.height,
  };
}

function scaleBox(box: number[], p: PreparedImage): [number, number, number, number] {
  const sx = p.origW / p.sentW;
  const sy = p.origH / p.sentH;
  return [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy];
}

// ---------------- vision_ground ----------------
export async function visionGround(image: string, target: string, language = "zh") {
  const lang = language === "en" ? "English" : "中文";
  const p = await prepareImage(image);
  const prompt =
    `你是一个目标定位工具。请在图片中定位目标【${target}】，返回其在图片中的像素边界框。` +
    `坐标系：原点在图片左上角，x 向右，y 向下。` +
    `只输出 JSON（不要任何其他文字）：{"box":[x1,y1,x2,y2],"label":"目标的简短描述","confidence":0~1}。` +
    `x1,y1 是左上角，x2,y2 是右下角。若图中不存在该目标，输出 {"box":null}。请用${lang}写 label。`;
  const raw = await callVision(p.dataUrl, prompt, 600);
  const parsed = extractJson(raw) as { box?: number[] | null; label?: string; confidence?: number };
  if (!parsed.box || parsed.box.length !== 4) {
    return { found: false, note: `未在图中定位到目标：“${target}”` };
  }
  const box = scaleBox(parsed.box, p);
  const img = await loadImage(image);
  drawBox(img, box[0], box[1], box[2], box[3], [255, 0, 0]);
  const annotated = await savePng("vision_ground", img);
  return {
    found: true,
    target,
    label: parsed.label ?? target,
    confidence: parsed.confidence ?? null,
    box: { x1: Math.round(box[0]), y1: Math.round(box[1]), x2: Math.round(box[2]), y2: Math.round(box[3]) },
    original_size: { width: p.origW, height: p.origH },
    annotated_path: annotated,
  };
}

// ---------------- vision_detect ----------------
export async function visionDetect(image: string, kind: string, language = "zh") {
  const lang = language === "en" ? "English" : "中文";
  const p = await prepareImage(image);
  const prompt =
    `你是一个元素检测工具。请列出图片中所有【${kind}】元素（默认：按钮、输入框、链接、图标等所有可交互或可见的元素）。` +
    `为每个元素编号并给出像素边界框（原点左上，x 向右，y 向下）。` +
    `只输出 JSON 数组（不要任何其他文字）：` +
    `[{"id":1,"label":"元素简要说明","box":[x1,y1,x2,y2]}, ...]。请用${lang}写 label。`;
  const raw = await callVision(p.dataUrl, prompt, 1200);
  const parsed = extractJson(raw) as Array<{ id?: number; label?: string; box?: number[] }>;
  const items = (Array.isArray(parsed) ? parsed : [])
    .filter((it) => Array.isArray(it.box) && it.box!.length === 4)
    .map((it, i) => {
      const box = scaleBox(it.box as number[], p);
      return {
        id: it.id ?? i + 1,
        label: it.label ?? "",
        box: {
          x1: Math.round(box[0]),
          y1: Math.round(box[1]),
          x2: Math.round(box[2]),
          y2: Math.round(box[3]),
        },
      };
    });
  const colors: Array<[number, number, number]> = [
    [255, 0, 0],
    [0, 153, 255],
    [0, 200, 0],
    [255, 128, 0],
    [153, 0, 255],
    [0, 200, 200],
  ];
  const img = await loadImage(image);
  items.forEach((it, i) => {
    const b = it.box;
    drawBox(img, b.x1, b.y1, b.x2, b.y2, colors[i % colors.length]);
  });
  const annotated = await savePng("vision_detect", img);
  return { kind, count: items.length, items, original_size: { width: p.origW, height: p.origH }, annotated_path: annotated };
}

// ---------------- vision_pixel_diff ----------------
export async function visionPixelDiff(reference: string, current: string, threshold = 16) {
  let ref = await loadImage(reference);
  let cur = await loadImage(current);
  let resized = false;
  if (ref.bitmap.width !== cur.bitmap.width || ref.bitmap.height !== cur.bitmap.height) {
    cur = cur.resize({ w: ref.bitmap.width, h: ref.bitmap.height }) as JimpImage;
    resized = true;
  }
  const W = ref.bitmap.width;
  const H = ref.bitmap.height;
  const rd = ref.bitmap.data;
  const cd = cur.bitmap.data;
  const total = W * H;
  const diff = Buffer.alloc(total);
  let diffPixels = 0;
  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    const dr = Math.abs(rd[idx] - cd[idx]);
    const dg = Math.abs(rd[idx + 1] - cd[idx + 1]);
    const db = Math.abs(rd[idx + 2] - cd[idx + 2]);
    if (dr > threshold || dg > threshold || db > threshold) {
      diff[i] = 1;
      diffPixels++;
    }
  }
  const heat: JimpImage = ref.clone() as JimpImage;
  for (let i = 0; i < total; i++) {
    if (diff[i]) {
      const idx = i * 4;
      heat.bitmap.data[idx] = 255;
      heat.bitmap.data[idx + 1] = 0;
      heat.bitmap.data[idx + 2] = 0;
      heat.bitmap.data[idx + 3] = 200;
    }
  }
  const heatmapPath = await savePng("vision_pixel_diff", heat);
  // 8x8 网格：找出差异最集中的格子
  const GRID = 8;
  const cells: Array<{ cell: string; ratio: number }> = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x0 = Math.floor((gx * W) / GRID);
      const x1 = Math.floor(((gx + 1) * W) / GRID);
      const y0 = Math.floor((gy * H) / GRID);
      const y1 = Math.floor(((gy + 1) * H) / GRID);
      let cnt = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (diff[y * W + x]) cnt++;
        }
      }
      const cellTotal = (x1 - x0) * (y1 - y0);
      if (cellTotal > 0) cells.push({ cell: `${gx + 1}x${gy + 1}`, ratio: cnt / cellTotal });
    }
  }
  cells.sort((a, b) => b.ratio - a.ratio);
  return {
    diff_ratio: diffPixels / total,
    diff_pixels: diffPixels,
    total_pixels: total,
    threshold,
    resized_to_match: resized,
    worst_regions: cells.slice(0, 5),
    heatmap_path: heatmapPath,
  };
}

// ---------------- vision_colors ----------------
export async function visionColors(image: string, n = 5) {
  const img = await loadImage(image);
  const W = img.bitmap.width;
  const H = img.bitmap.height;
  const d = img.bitmap.data;
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();
  for (let i = 0; i < W * H; i++) {
    const idx = i * 4;
    const a = d[idx + 3];
    if (a < 128) continue;
    const r = d[idx] >> 3;
    const g = d[idx + 1] >> 3;
    const b = d[idx + 2] >> 3;
    const key = (r << 10) | (g << 5) | b;
    const cur = buckets.get(key);
    if (cur) {
      cur.count++;
      cur.r += d[idx];
      cur.g += d[idx + 1];
      cur.b += d[idx + 2];
    } else {
      buckets.set(key, { r: d[idx], g: d[idx + 1], b: d[idx + 2], count: 1 });
    }
  }
  const total = [...buckets.values()].reduce((s, v) => s + v.count, 0);
  const top = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, Math.min(n, 16));
  const toHex = (v: number) => v.toString(16).padStart(2, "0");
  return {
    colors: top.map((c) => ({
      hex: `#${toHex(Math.round(c.r / c.count))}${toHex(Math.round(c.g / c.count))}${toHex(Math.round(c.b / c.count))}`,
      share: c.count / total,
    })),
  };
}

// ---------------- vision_html_screenshot ----------------
async function findBrowser(): Promise<string | null> {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) {
    try {
      await import("node:fs").then((fs) => fs.promises.access(c));
      return c;
    } catch {
      /* continue */
    }
  }
  return null;
}

export async function visionHtmlScreenshot(html: string, viewport = "1440x900") {
  const browser = await findBrowser();
  if (!browser) throw new Error("未找到系统 Chrome/Edge，无法渲染 HTML 截图");
  const [vw, vh] = viewport.split(/[xX,]/).map((s) => parseInt(s, 10));
  const width = Number.isFinite(vw) && vw > 0 ? vw : 1440;
  const height = Number.isFinite(vh) && vh > 0 ? vh : 900;

  let target: string;
  if (isHttpUrl(html)) {
    target = html;
  } else if (/^[a-zA-Z]:[\\/]/.test(html) || html.includes("\\") || html.includes("/")) {
    target = pathToFileURL(path.resolve(html)).href;
  } else {
    // 视为内联 HTML 字符串，写入临时文件
    await ensureOutputDir();
    const tmp = path.join(OUTPUT_DIR, `html-${Date.now()}.html`);
    await writeFile(tmp, html, "utf-8");
    target = pathToFileURL(tmp).href;
  }
  await ensureOutputDir();
  const out = path.join(OUTPUT_DIR, `vision_html_screenshot-${Date.now()}.png`);
  const userData = path.join(OUTPUT_DIR, `chrome-profile-${randomUUID().slice(0, 8)}`);
  await execFileAsync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userData}`,
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      target,
    ],
    { timeout: 90_000, windowsHide: true },
  );
  return { path: out, width, height, browser };
}

// ---------------- vision_bootstrap ----------------
export async function visionBootstrap(image: string, language = "zh") {
  const lang = language === "en" ? "English" : "中文";
  const p = await prepareImage(image);
  const prompt =
    `你是结构化视觉预读工具。对图片做一次全面的首轮分析，输出 JSON（不要任何其他文字）：` +
    `{"summary":"整体概括","layout_regions":[{"region":"区域名","description":"该区域内容"}],` +
    `"entities":[{"type":"对象类型","description":"对象描述"}],` +
    `"text":"图中所有可见文字的逐字提取（无文字则为空字符串")}。请用${lang}写文本字段。`;
  const raw = await callVision(p.dataUrl, prompt, 1500);
  return extractJson(raw);
}
