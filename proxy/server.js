"use strict";
// vision-proxy: Codex <-> DeepSeek 之间的"眼睛"桥。
// 收到带图请求 -> 调用视觉模型(qwen3.7-flash)转成文字 -> 替换图片 -> 转发给上游网关。
// 零依赖：仅用 Node 内置 http/fetch。启动参数见 .env
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// ---- 加载同目录 .env（KEY=VALUE，不覆盖已存在的环境变量）----
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const PORT = Number(process.env.PROXY_PORT || 5843);
const UPSTREAM = (process.env.UPSTREAM_URL || "http://localhost:5842").replace(/\/+$/, "");
const VISION_API_URL = process.env.VISION_API_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const VISION_MODEL = process.env.VISION_MODEL || "qwen3.7-flash";
const API_KEY = process.env.QIANWEN_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.ZHIPU_API_KEY || "";
const VISION_PROMPT = process.env.VISION_PROMPT ||
  "你是一个识图桥接工具。用户粘贴了一张图片，主模型（DeepSeek）看不到像素。请完整、准确地用中文描述这张图片：" +
  "主要对象、全部可见文字（逐字 OCR）、布局、颜色与关键细节。只输出图片内容描述，不要客套。";

async function describeImage(imageUrl) {
  if (!API_KEY) return "[图片识别失败：代理未配置 QIANWEN_API_KEY / DASHSCOPE_API_KEY]";
  try {
    const res = await fetch(VISION_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: VISION_PROMPT },
          ],
        }],
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error("vision api HTTP " + res.status + ": " + raw.slice(0, 200));
    const j = JSON.parse(raw);
    const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof t !== "string" || !t.trim()) throw new Error("vision api returned empty content");
    return t.trim();
  } catch (err) {
    return "[图片识别失败：" + (err && err.message ? err.message : String(err)) + "]";
  }
}

function extractImageUrl(part) {
  if (part && typeof part.image_url === "string") return part.image_url;
  if (part && part.image_url && typeof part.image_url === "object" && part.image_url.url) return part.image_url.url;
  if (part && part.type === "input_image" && part.data) {
    return "data:" + (part.media_type || "image/png") + ";base64," + part.data;
  }
  return null;
}

async function rewriteImages(obj) {
  let replaced = 0;
  const input = obj && Array.isArray(obj.input) ? obj.input : [];
  for (const item of input) {
    if (item && Array.isArray(item.content)) {
      for (let i = 0; i < item.content.length; i++) {
        const part = item.content[i];
        if (part && part.type === "input_image") {
          const url = extractImageUrl(part);
          if (url) {
            const text = await describeImage(url);
            item.content[i] = { type: "input_text", text: "【用户粘贴的图片，已由视觉模型识别】\n" + text };
          } else {
            item.content[i] = { type: "input_text", text: "【用户粘贴了一张图片，但代理无法读取图片数据】" };
          }
          replaced++;
        }
      }
    }
  }
  return replaced;
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("vision-proxy: only POST supported");
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let outBody = Buffer.concat(chunks).toString("utf8");
    let replaced = 0;
    try {
      if (outBody.trim()) {
        const obj = JSON.parse(outBody);
        replaced = await rewriteImages(obj);
        outBody = JSON.stringify(obj);
      }
    } catch (e) {
      // 不是合法 JSON 就原样转发
    }
    const upPath = req.url.startsWith("/v1") ? req.url : "/v1" + req.url;
    const target = new URL(UPSTREAM + upPath);
    const fwd = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: "POST",
      headers: Object.assign({}, req.headers, { host: target.host, "content-length": Buffer.byteLength(outBody) }),
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    fwd.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("vision-proxy upstream error: " + err.message);
    });
    fwd.end(outBody);
    if (replaced > 0) console.log("[vision-proxy] replaced " + replaced + " image(s) at " + new Date().toISOString());
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[vision-proxy] listening on http://127.0.0.1:" + PORT + " -> " + UPSTREAM);
  console.log("[vision-proxy] vision model: " + VISION_MODEL);
  console.log("[vision-proxy] api key configured: " + (API_KEY ? "yes" : "NO"));
});