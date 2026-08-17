import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { describeImage } from "./glm.js";
import { describeImageMimo } from "./mimo.js";
import { resolveImageUrl } from "./image.js";
import { resolveCroppedImageUrl } from "./crop.js";
import {
  visionGround,
  visionDetect,
  visionPixelDiff,
  visionHtmlScreenshot,
  visionColors,
  visionBootstrap,
} from "./vision_tools.js";

const GLM_API_KEY = process.env.QIANWEN_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.ZHIPU_API_KEY || "";
const MIMO_API_KEY = process.env.OPENCODE_API_KEY || "";

const server = new McpServer({
  name: "glm-vision",
  version: "1.0.0",
});

server.registerTool(
  "analyze_image",
  {
    title: "分析图片（Qwen 视觉模型 qwen3.7-flash）",
    description:
      "识别并描述图片内容。使用 Qwen 视觉模型（qwen3.7-flash，千问AI平台/DashScope）。传入本地图片的绝对路径（支持 jpg/jpeg/png/webp/gif/bmp，≤10MB）或 http(s) 图片 URL，以及可选的问题或指令。支持图片描述、OCR 文字提取、截图/图表/界面分析、物体与属性识别等。",
    inputSchema: {
      image: z.string().describe("本地图片绝对路径或 http(s) 图片 URL"),
      question: z
        .string()
        .optional()
        .describe("对图片的具体问题或指令，例如：提取图中所有文字、描述界面布局、识别图中的物体"),
      detail: z
        .enum(["brief", "standard", "detailed"])
        .optional()
        .describe("回答详略程度（无 question 时生效），默认 standard"),
      thinking: z
        .boolean()
        .optional()
        .describe("是否开启深度思考模式（更慢但更深入），默认 false"),
      language: z
        .enum(["auto", "zh", "en"])
        .optional()
        .describe("输出语言：auto 跟随问题语言，无问题时默认中文，默认 auto"),
      region: z
        .string()
        .optional()
        .describe('只看图片的某个局部区域（放大该区域后分析，减少细节转述丢失）：九宫格名称 top-left/top-center/top-right/middle-left/middle-center/middle-right/bottom-left/bottom-center/bottom-right，或像素矩形 "x,y,w,h"（可用百分比，如 "10%,20%,60%,30%"）。默认 full（整图）。文字/小细节用先整图再逐区域追问的策略'),
    },
  },
  async ({ image, question, detail = "standard", thinking = false, language = "auto", region = "full" }) => {
    let mimoFailure: string | null = null;
    try {
      let imageUrl = image;
      let regionNote = "";
      if (region && region !== "full") {
        const cropped = await resolveCroppedImageUrl(image, region);
        imageUrl = cropped.dataUrl;
        regionNote = cropped.regionLabel;
      } else {
        imageUrl = await resolveImageUrl(image);
      }

      // 优先尝试 MiMo V2.5 Free
      if (MIMO_API_KEY) {
        try {
          const text = await describeImageMimo({
            apiKey: MIMO_API_KEY,
            imageUrl,
            question,
            detail,
            thinking,
            language,
            regionLabel: regionNote,
          });
          return { content: [{ type: "text" as const, text }] };
        } catch (mimoError) {
          mimoFailure = mimoError instanceof Error ? mimoError.message : String(mimoError);
          // 继续尝试 GLM
        }
      }

      // 回退到 GLM-4.6V-Flash
      if (!GLM_API_KEY) {
        return errorResult(
          "缺少 API Key：请在 ~/.codex/config.toml 的 [mcp_servers.vision.env] 中设置 QIANWEN_API_KEY（千问AI平台 / DashScope API Key）。",
        );
      }
      const text = await describeImage({
        apiKey: GLM_API_KEY,
        imageUrl,
        question,
        detail,
        thinking,
        language,
        regionLabel: regionNote,
      });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const mimoNote = mimoFailure ? `\n[MiMo V2.5 Free 失败原因] ${mimoFailure}` : "";
      return errorResult(message + mimoNote);
    }
  },
);

server.registerTool(
  "vision_ground",
  {
    title: "目标定位：返回像素坐标框",
    description:
      "在图片中定位指定目标，返回原图像素坐标边界框 [x1,y1,x2,y2] 并在标注图上画出红框。传入本地图片绝对路径或 http(s) URL，以及目标描述。",
    inputSchema: {
      image: z.string().describe("本地图片绝对路径或 http(s) 图片 URL"),
      target: z.string().describe("要定位的目标，例如：蓝色方块、登录按钮、输入框"),
      language: z.enum(["zh", "en"]).optional().describe("输出语言，默认 zh"),
    },
  },
  async ({ image, target, language = "zh" }) => {
    try {
      const r = await visionGround(image, target, language);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "vision_detect",
  {
    title: "元素编号清单 + 坐标框",
    description:
      "列出图片中所有指定类型的元素（按钮/输入框/链接/图标等），每个元素给出编号与像素坐标框，并生成带编号框的标注图。",
    inputSchema: {
      image: z.string().describe("本地图片绝对路径或 http(s) 图片 URL"),
      kind: z.string().optional().describe("要检测的元素类型，例如：按钮、输入框、链接，默认全部可交互元素"),
      language: z.enum(["zh", "en"]).optional().describe("输出语言，默认 zh"),
    },
  },
  async ({ image, kind = "按钮、输入框、链接、图标等所有可交互或可见元素", language = "zh" }) => {
    try {
      const r = await visionDetect(image, kind, language);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "vision_pixel_diff",
  {
    title: "像素级对比 + 红色热力图",
    description:
      "逐像素对比两张图片：输出差异比例、差异像素数、差异最集中的 8x8 网格区域排名，并生成红色热力图 PNG（本地计算，不调用视觉模型）。",
    inputSchema: {
      reference: z.string().describe("参考图（基准）的本地绝对路径或 http(s) URL"),
      current: z.string().describe("当前图（待对比）的本地绝对路径或 http(s) URL"),
      threshold: z.number().int().min(0).max(255).optional().describe("单通道差异阈值，默认 16"),
    },
  },
  async ({ reference, current, threshold = 16 }) => {
    try {
      const r = await visionPixelDiff(reference, current, threshold);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "vision_html_screenshot",
  {
    title: "本地截图 / HTML 渲染",
    description:
      "用系统 Chrome/Edge headless 把 HTML（文件路径、URL 或内联 HTML 字符串）渲染成 PNG 截图，返回图片路径与尺寸。",
    inputSchema: {
      html: z.string().describe("HTML 文件绝对路径、http(s) URL，或内联 HTML 字符串"),
      viewport: z.string().optional().describe("视口尺寸，如 1440x900，默认 1440x900"),
    },
  },
  async ({ html, viewport = "1440x900" }) => {
    try {
      const r = await visionHtmlScreenshot(html, viewport);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "vision_colors",
  {
    title: "主色调提取",
    description:
      "提取图片的主色调（本地计算）：输出前 N 个主色的 HEX 值与占比。",
    inputSchema: {
      image: z.string().describe("本地图片绝对路径或 http(s) 图片 URL"),
      n: z.number().int().min(1).max(16).optional().describe("返回主色数量，默认 5"),
    },
  },
  async ({ image, n = 5 }) => {
    try {
      const r = await visionColors(image, n);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "vision_bootstrap",
  {
    title: "结构化首轮视觉预读",
    description:
      "对图片做一次结构化首轮分析：输出整体概括 summary、布局区域 layout_regions、实体清单 entities、逐字文字 text（JSON）。",
    inputSchema: {
      image: z.string().describe("本地图片绝对路径或 http(s) 图片 URL"),
      language: z.enum(["zh", "en"]).optional().describe("输出语言，默认 zh"),
    },
  },
  async ({ image, language = "zh" }) => {
    try {
      const r = await visionBootstrap(image, language);
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `图片分析失败：${message}` }],
    isError: true,
  };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("glm-vision MCP 启动失败：", err);
  process.exit(1);
});
