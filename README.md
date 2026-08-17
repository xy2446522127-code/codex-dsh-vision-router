# codex-dsh-vision-router

> Codex 版"识图眼睛"：让纯文本模型（如 DeepSeek-V4-Flash）在 Codex 里获得识图能力。
> Eyes for text-only models on Codex — DeepSeek stays the brain, the vision model does the seeing.

与 DeepSeek Harness 生态的 [dsh-vision-router](https://github.com/ysr666/dsh-vision-router) 设计同源：
**主模型永远只吃文字，视觉模型只当眼睛**，图片按需交给视觉模型解析后以文字返回。

## 功能

### 1. MCP 工具 `analyze_image`（必装，给路径/URL 即识图）

- 本地 MCP 服务器，注册到 `~/.codex/config.toml` 后，模型拿到图片路径或 http(s) URL 即可自动调用。
- 支持：图片描述、OCR 逐字提取、截图/图表/界面分析、物体识别、局部区域放大（`region` 九宫格/像素矩形）。
- 默认视觉模型 `qwen3.7-flash`（千问AI平台 / DashScope 兼容端点），可被 `VISION_API_URL` / `VISION_MODEL` 覆盖，任意 OpenAI 兼容视觉端点都能用。
- 本地图片自动压缩（>512KB 缩放为 ≤1280px JPEG85%）与 429 重试。

### 2. 本地代理 vision-proxy（可选，粘贴即自动识图）

- 插在 Codex 与模型网关之间：收到带图请求 → 视觉模型识图 → 文字替换图片 → 再转发。
- 效果：在 Codex 里使用纯文本模型时**直接粘贴图片即可自动识图**，无需给路径。
- 纯文本请求原样透传；视觉调用失败时降级为"去图转发"，不中断对话。

## 架构

```text
Codex  ──(粘贴图片)──▶  本地代理 :5843  ──(文字)──▶  模型网关 → DeepSeek
                           │  带图时：
                           ▼
                     qwen3.7-flash（视觉模型，DashScope 兼容端点）
```

## 安装

### 依赖

- Node.js ≥ 18
- Codex（CLI 或桌面端）
- 一个 OpenAI 兼容的视觉模型 API Key（默认千问AI平台/DashScope：`https://dashscope.aliyuncs.com/compatible-mode/v1`）

### 1. 构建 MCP 服务器

```bash
cd mcp
npm install
npm run build
```

### 2. 注册到 Codex

编辑 `~/.codex/config.toml`，追加（key 用你自己的）：

```toml
[mcp_servers.vision]
command = "node"
args = ["<本仓库绝对路径>/mcp/dist/index.js"]
env = { QIANWEN_API_KEY = "YOUR_QIANWEN_OR_DASHSCOPE_API_KEY" }
enabled = true
```

**完全退出并重新打开 Codex**（仅关窗口不够），新建会话后模型即可调用 `mcp__vision__analyze_image`。

### 3. （可选）粘贴即自动识图：启动本地代理

```bash
cd proxy
cp .env.example .env        # 填入你的 API Key
node server.js              # 默认监听 127.0.0.1:5843
```

然后把你的模型 provider `base_url` 指向 `http://127.0.0.1:5843/v1`（代理会把请求转发给 `.env` 里 `UPSTREAM_URL` 指定的网关）。

Windows 隐藏自启参考：`proxy/start-hidden.vbs.example`（放入启动文件夹并把路径换成你的）。

## 配置项

| 变量 | 默认值 | 说明 |
|---|---|---|
| `QIANWEN_API_KEY` | （必填） | 视觉模型 API Key（千问AI平台/DashScope，或任意 OpenAI 兼容服务） |
| `VISION_API_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | 视觉模型端点 |
| `VISION_MODEL` | `qwen3.7-flash` | 视觉模型名 |
| `UPSTREAM_URL`（仅代理） | `http://localhost:5842/v1` | 代理转发的上游网关 |
| `PROXY_PORT`（仅代理） | `5843` | 代理监听端口 |

## 使用示例

- "分析 `C:\Users\me\shots\error.png`"
- "提取这张图里的所有文字（OCR）：`https://example.com/xxx.png`"
- "只看这张图的右下角：`.../ui.png`，`region=bottom-right`"

## 安全说明

- **不要提交真实 API Key**：仓库只含占位符，Key 只写在你本机的 `.env` 或 `config.toml` 的 `env` 中。
- 若日后 DeepSeek 官方脚本生成 `~/.codex/models.json` 且 `supports_search_tool=true` + `tool_mode=null`，新版 Codex 会静默隐藏所有 MCP 工具（openai/codex#36382），把该字段改为 `false` 并彻底重启即可。

## License

MIT。本项目 MCP 服务器基于 [configure-glm-vision](https://github.com/LinHaiJ/configure-glm-vision)（MIT）改造，设计思路受 [dsh-vision-router](https://github.com/ysr666/dsh-vision-router) 启发。
