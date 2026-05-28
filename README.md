# YouTube 对话文章生成器

一个部署在 Cloudflare Workers 上的 Node.js / TypeScript 小应用：用户输入带字幕的 YouTube 链接，服务端获取字幕并调用 Gemini AI Studio API，流式生成中文视频对话内容文章。页面还支持按章节生成 5W1H 总结。

## 功能

- 输入 YouTube 视频链接，自动解析 `videoId`
- 优先获取 YouTube 字幕，失败时使用内置字幕兜底
- 调用 Gemini `streamGenerateContent` 生成中文文章
- 主文章通过 SSE 流式返回，前端实时展示
- 可输入自然语言生成要求，影响文章任务、风格、受众和约束
- 章节级 5W1H 总结，前端只提交 `sessionId` 和章节标题，不重新提交全文

## 本地运行

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

在 `.dev.vars` 中填入 Google AI Studio 的免费 Gemini API Key：

```bash
GEMINI_API_KEY="your-key"
SUPADATA_API_KEY="your-supadata-key"
```

如果需要用 webshare.io 代理获取 YouTube 字幕，可以继续配置：

```bash
WEBSHARE_PROXY_HOST="proxy.webshare.io"
WEBSHARE_PROXY_PORT="80"
WEBSHARE_PROXY_USERNAME="your-webshare-username"
WEBSHARE_PROXY_PASSWORD="your-webshare-password"
```

默认模型配置在 `wrangler.toml`：

```toml
GEMINI_MODEL = "gemini-2.5-flash"
```

## 部署

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put SUPADATA_API_KEY
npx wrangler secret put WEBSHARE_PROXY_USERNAME
npx wrangler secret put WEBSHARE_PROXY_PASSWORD
npm run deploy
```

部署完成后，Wrangler 会输出公开访问网址。

## 如何获取和处理 YouTube 字幕

服务端在 `src/services/youtube.ts` 中完成字幕处理：

1. 从用户输入的 YouTube URL 中解析 `videoId`。
2. 优先直连 YouTube `timedtext` 和 watch page，尝试获取字幕轨道。
3. 如果直连失败，调用 Supadata `GET /youtube/transcript/translate`，目标语言为 `zh`，获取中文字幕。
4. 如果 Supadata 失败，再使用 Webshare TCP Socket 代理池重试 YouTube 字幕请求。
5. 如果解析失败、没有字幕、请求被拦截或遇到验证码，则使用 `src/fixtures/transcript.ts` 中的硬编码字幕。

YouTube 字幕获取本身不稳定，所以 fallback 是产品体验和演示稳定性的关键部分。

Supadata 调用在 `src/services/supadata.ts`。它使用 `https://api.supadata.ai/v1` 作为 Base URL，并通过 `x-api-key` header 认证。当前项目使用免费计划可用的 Universal Transcript 接口，先请求中文已有字幕，失败后请求英文已有字幕。为了保留时间信息，项目请求结构化字幕片段：

```text
GET /transcript?url={videoUrl}&lang=zh&text=false&chunkSize=1000&mode=native
GET /transcript/{jobId}
```

当 Supadata 返回 `content` 数组时，项目会保留每段字幕的 `text`、`offset`、`duration` 和 `lang`。长视频场景下，主文章 prompt 会优先按时间片段抽取代表性内容，避免把超长字幕一次性塞给 Gemini 导致首包延迟过高。

如果遇到 YouTube 验证码，可以接入 webshare.io 等代理服务。Cloudflare Worker 的普通 `fetch` 不支持直接配置代理；当前项目在 `src/services/proxy.ts` 中使用 Cloudflare Workers TCP Socket `connect()` 连接 Webshare HTTP proxy，并在直接请求失败时自动通过代理重试 YouTube 字幕请求。

代理链路是可选增强：

1. 未配置 `WEBSHARE_PROXY_*`：只使用 Worker 原生 `fetch`，失败后 fallback。
2. 已配置 `WEBSHARE_PROXY_*`：原生 `fetch` 失败后，使用 TCP Socket 连接 Webshare 代理重试。
3. 代理仍失败：继续 fallback 到内置字幕，保证主文章生成流程可用。

注意：Webshare 的代理地址、端口、用户名、密码以控制台实际分配为准。部署到 Cloudflare 时，建议把用户名和密码配置为 secrets。

## 如何调用 Gemini 并实现流式输出

Gemini 调用在 `src/services/gemini.ts`：

- 主文章生成使用：

```text
POST /v1beta/models/{model}:streamGenerateContent?alt=sse
```

- Worker 读取 Gemini 返回的 SSE。
- 每解析出一段文本，就写入自己的 `TransformStream`。
- `/api/generate` 返回 `text/event-stream`。
- 前端用 `fetch()` 和 `ReadableStream.getReader()` 逐块读取并实时渲染。

这样主文章不会等 Gemini 完整生成后才展示，满足“生成一点输出一点”的要求。

## 用户生成要求如何影响输出

用户在页面输入的自然语言要求会进入 `buildArticlePrompt()`：

- 任务类型：例如“写成深度分析”或“写成播客纪要”
- 输出风格：例如“克制、商业化、口语化”
- 目标受众：例如“写给非技术管理者”
- 约束条件：例如“重点讲商业模式，不要太技术”

Prompt 会要求模型在不违背字幕事实的前提下尽量体现这些约束。

## 章节级 5W1H 总结

生成主文章时，服务端会创建一个内存 session，保存：

- `sessionId`
- `videoId`
- 原始字幕
- 用户生成要求
- 已生成文章内容

前端点击章节标题旁的 `5W1H` 按钮时，只提交：

```json
{
  "sessionId": "...",
  "sectionTitle": "..."
}
```

服务端通过 `sessionId` 找回本次生成上下文，再调用 Gemini 普通 `generateContent`，要求只返回固定 JSON：

```json
{
  "who": "...",
  "what": "...",
  "when": "...",
  "where": "...",
  "why": "...",
  "how": "..."
}
```

前端固定格式渲染 Who / What / When / Where / Why / How。

当前版本用 Worker 内存 Map 保存 session，适合演示和笔试提交。生产化可以替换为 Cloudflare KV、D1 或 Durable Object。

## 工程取舍和亮点

- 单 Worker 全栈实现，部署路径短，评审者可以快速理解。
- 不引入前端框架，页面交互用原生 Web API，减少构建复杂度。
- Gemini 使用 REST API，不依赖 Node SDK，天然适配 Worker runtime。
- YouTube 字幕真实获取和硬编码 fallback 并存，兼顾完整性和演示稳定性。
- 主文章生成严格流式输出，前端实时渲染。
- 5W1H 总结基于服务端 session，不让前端重复提交整篇文章。
