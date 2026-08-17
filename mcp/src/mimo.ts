const MIMO_API_URL = "https://opencode.ai/zen/v1/chat/completions";
const MIMO_MODEL = "mimo-v2.5-free";
const REQUEST_TIMEOUT_MS = 60_000;
/** 免费模型容易被限流（429），按间隔重试一次 */
const RETRY_DELAYS_MS = [3_000, 10_000];

export type DetailLevel = "brief" | "standard" | "detailed";
export type Language = "auto" | "zh" | "en";

export interface DescribeImageParams {
  apiKey: string;
  imageUrl: string;
  question?: string;
  detail: DetailLevel;
  thinking: boolean;
  language: Language;
  regionLabel?: string;
}

const DEFAULT_PROMPTS: Record<DetailLevel, string> = {
  brief: "请用简洁的语言概括这张图片的内容（1-3 句话）。",
  standard: "请详细描述这张图片：主要对象、场景、人物/物体、可见文字、布局与整体氛围。",
  detailed:
    "请非常详细地分析这张图片：所有可见对象与细节、全部可读文字（OCR）、空间布局、颜色与风格、内容含义与可能的用途。",
};

function buildSystemPrompt(language: Language): string {
  const langNote =
    language === "zh"
      ? "始终使用中文回复。"
      : language === "en"
        ? "Always reply in English."
        : "使用与用户提问相同的语言回复；若用户没有提问，默认使用中文。";
  return [
    "你是 MiMo V2.5 Free 视觉模型，通过 MCP 工具为 Codex 提供识图能力。",
    "请如实、准确、完整地描述图片内容；不要臆测或编造图中不存在的信息。",
    "对于看不清或不确定的内容，请明确说明不确定性，而不是猜测。",
    "当任务是 OCR（文字提取）时，请逐字提取可见文字并尽量保留原文。",
    langNote,
  ].join("\n");
}

export async function describeImageMimo(params: DescribeImageParams): Promise<string> {
  const userText =
    params.question && params.question.trim()
      ? params.question.trim()
      : DEFAULT_PROMPTS[params.detail];

  const regionNote = params.regionLabel
    ? `\n注意：你看到的这张图片是原图的局部裁剪区域（${params.regionLabel}），请仅针对该区域内容回答，不要推断区域外的情况。`
    : "";

  const payload: Record<string, unknown> = {
    model: MIMO_MODEL,
    messages: [
      { role: "system", content: buildSystemPrompt(params.language) },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: params.imageUrl } },
          { type: "text", text: userText + regionNote },
        ],
      },
    ],
    max_tokens: 2048,
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }

    let response: Response;
    try {
      response = await fetch(MIMO_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const networkError = new Error(`调用 MiMo API 失败（网络或超时）：${message}`);
      if (attempt < RETRY_DELAYS_MS.length) {
        lastError = networkError;
        continue;
      }
      throw networkError;
    }

    const raw = await response.text();
    if (response.ok) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`MiMo API 返回了无法解析的响应：${raw.slice(0, 300)}`);
      }
      const text = (parsed as {
        choices?: Array<{ message?: { content?: unknown } }>;
      })?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error("MiMo API 未返回有效文本内容");
      }
      return text.trim();
    }

    if (response.status === 429) {
      lastError = new Error(formatApiError(429, raw));
      if (attempt < RETRY_DELAYS_MS.length) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        if (retryAfterMs && retryAfterMs > RETRY_DELAYS_MS[attempt]) {
          await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
          continue;
        }
      }
      continue;
    }
    throw new Error(formatApiError(response.status, raw));
  }

  throw lastError ?? new Error("MiMo API 请求失败");
}

/** 解析 Retry-After 头（秒数或 HTTP 日期），返回毫秒；解析失败返回 null */
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(seconds * 1000, 60_000);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(date - Date.now(), 60_000);
  }
  return null;
}

function formatApiError(status: number, raw: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string };
      message?: string;
    };
    detail = parsed?.error?.message || parsed?.message || raw.slice(0, 300);
  } catch {
    detail = raw.slice(0, 300);
  }
  if (status === 401) {
    return `API Key 无效或已过期（401）：请检查 OpenCode Zen 的 OPENCODE_API_KEY。详情：${detail}`;
  }
  if (status === 429) {
    return `请求过于频繁或超出免费额度（429）：请稍后重试。详情：${detail}`;
  }
  if (status === 400) {
    return `请求参数错误（400）：${detail}`;
  }
  return `MiMo API 返回错误（${status}）：${detail}`;
}