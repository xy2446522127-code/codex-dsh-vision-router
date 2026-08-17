import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { describeImage } from "./glm.js";
import { describeImageMimo } from "./mimo.js";
import { resolveImageUrl } from "./image.js";
import { resolveCroppedImageUrl } from "./crop.js";

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