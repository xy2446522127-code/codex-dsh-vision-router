import path from "node:path";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "..", "dist", "index.js");
const sampleImage = path.resolve(__dirname, "sample.png");
const sampleTxt = path.resolve(__dirname, "sample.txt");
const bigImage = path.resolve(__dirname, "big.png");

// 自动生成超 10MB 的测试素材（big.png），避免新环境缺少该文件
if (!existsSync(bigImage)) {
  const fd = openSync(bigImage, "w");
  try {
    writeSync(fd, Buffer.alloc(11 * 1024 * 1024, 0));
  } finally {
    closeSync(fd);
  }
}

const failures = [];
function check(name, condition, extra = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.error(`  ✗ ${name}${extra ? ` -> ${extra}` : ""}`);
  }
}

async function withClient(envOverrides, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, ...envOverrides },
    stderr: "pipe",
  });
  const client = new Client({ name: "glm-vision-smoke", version: "1.0.0" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

async function callImage(client, args) {
  const res = await client.callTool({ name: "analyze_image", arguments: args });
  const text = Array.isArray(res.content)
    ? res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
    : String(res.content);
  return text;
}

const full = process.argv[2] === "full";

const NO_KEY_ENV = { QIANWEN_API_KEY: "", DASHSCOPE_API_KEY: "", ZHIPU_API_KEY: "", BIGMODEL_API_KEY: "", OPENCODE_API_KEY: "" };

console.log("场景 1：tools/list");
await withClient({}, async (client) => {
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  check("analyze_image 已注册", names.includes("analyze_image"), names.join(","));
});

console.log("场景 2：缺少 API Key");
await withClient(NO_KEY_ENV, async (client) => {
  const text = await callImage(client, { image: sampleImage });
  check("返回缺少 Key 错误", text.includes("缺少 API Key"), text);
});

console.log("场景 3：文件不存在");
await withClient(NO_KEY_ENV, async (client) => {
  const text = await callImage(client, { image: path.resolve(__dirname, "nope.png") });
  check("返回找不到文件错误", text.includes("找不到本地图片文件"), text);
});

console.log("场景 4：不支持的格式");
await withClient(NO_KEY_ENV, async (client) => {
  const text = await callImage(client, { image: sampleTxt });
  check("返回格式不支持错误", text.includes("不支持的图片格式"), text);
});

console.log("场景 5：超大图片");
await withClient(NO_KEY_ENV, async (client) => {
  const text = await callImage(client, { image: bigImage });
  check("返回图片过大错误", text.includes("图片过大"), text);
});

if (full) {
  console.log("场景 6：无效 API Key（联网）");
  await withClient({ ...NO_KEY_ENV, QIANWEN_API_KEY: "invalid-key-for-test" }, async (client) => {
    const text = await callImage(client, { image: sampleImage });
    check("返回 401 错误", /401|API Key 无效/.test(text), text);
  });

  if (process.env.QIANWEN_API_KEY) {
    console.log("场景 7：真实 Key 本地图片");
    await withClient({}, async (client) => {
      const text = await callImage(client, { image: sampleImage, detail: "detailed" });
      check("返回了非空描述", text.length > 0 && !text.startsWith("图片分析失败"), text.slice(0, 200));
      console.log("  结果预览：", text.slice(0, 300));
    });

    console.log("场景 8：真实 Key URL 图片");
    await withClient({}, async (client) => {
      const text = await callImage(client, {
        image: "https://cdn.bigmodel.cn/static/logo/register.png",
        question: "这张图片主要展示了什么？",
      });
      check("URL 图片返回非空结果", text.length > 0 && !text.startsWith("图片分析失败"), text.slice(0, 200));
      console.log("  结果预览：", text.slice(0, 300));
    });

    console.log("场景 9：OCR 提问");
    await withClient({}, async (client) => {
      const text = await callImage(client, {
        image: sampleImage,
        question: "请逐字提取图中所有文字",
      });
      check("OCR 返回非空结果", text.length > 0 && !text.startsWith("图片分析失败"), text.slice(0, 200));
      console.log("  结果预览：", text.slice(0, 300));
    });
  } else {
    console.log("场景 7-9：跳过（未设置真实 ZHIPU_API_KEY，请先设置环境变量再运行 full 测试）");
  }
}

if (failures.length > 0) {
  console.error(`\n失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log("\n全部通过 ✓");
