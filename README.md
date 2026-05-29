# YouTube 视频字幕文章生成器


## 本地运行

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars` 中需要配置：

```bash
GEMINI_API_KEY="your-gemini-key"
SUPADATA_API_KEY="your-supadata-key"
```

可选配置 Webshare 代理：

```bash
WEBSHARE_PROXY_HOSTS="ip1,ip2"
WEBSHARE_PROXY_PORTS="port1,port2"
WEBSHARE_PROXY_USERNAME="your-username"
WEBSHARE_PROXY_PASSWORD="your-password"
```

部署：

```bash
npm run typecheck
npm run deploy
```

当前默认模型和分块大小在 `wrangler.toml` 中配置：

```toml
GEMINI_MODEL = "gemini-3-flash-preview"
TRANSLATION_CHUNK_CHARS = "6000"
```

## 如何获取和处理 YouTube 字幕

字幕获取在 `src/services/youtube.ts` 中实现，采用多级兜底：

1. 解析用户输入的 YouTube URL，提取 `videoId`。
2. 优先直连 YouTube `timedtext` 接口获取字幕轨道。
3. 如果 `timedtext` 没有结果，再解析 watch page 中的 `ytInitialPlayerResponse` 和 `captionTracks`。
4. 如果 YouTube 触发验证码或没有返回字幕，调用 Supadata Universal Transcript API 获取结构化字幕。
5. 如果 Supadata 也失败，再尝试通过 Webshare 代理请求 YouTube。
6. 如果仍失败，并且视频是示例视频 `xRh2sVcNXQ8`，使用 `src/fixtures/downloaded-transcript.ts` 中预下载的完整字幕备份。
7. 最后再兜底到 `src/fixtures/transcript.ts` 中的短版示例字幕，保证演示流程可用。

Supadata 请求使用结构化字幕格式：

```text
GET /transcript?url={videoUrl}&lang=zh&text=false&chunkSize=1000&mode=native
```

如果中文字幕为空，会自动回退到英文字幕。返回的 `content` 数组会被标准化为 `TranscriptSegment[]`，保留 `text`、`startMs`、`durationMs` 和 `lang`。自动生成字幕不影响处理，只要接口能返回文本和时间片段，就按同样流程进入后续生成。

为了避免第三方接口不稳定，项目提供了脚本预下载示例字幕：

```bash
npm run fixture:transcript
```

该脚本会从 Supadata 下载示例视频字幕，并写入 `src/fixtures/downloaded-transcript.ts`，作为部署后的硬编码备份。

## 如何调用 Gemini 并实现流式输出

Gemini 调用在 `src/services/gemini.ts` 中实现，没有使用 Node SDK，而是直接调用 REST API，适配 Cloudflare Worker runtime。

主文章生成使用：

```text
POST /v1beta/models/{model}:streamGenerateContent?alt=sse
```

实现流程：

1. Worker 创建 `TransformStream`，接口 `/api/generate` 返回 `text/event-stream`。
2. 服务端向 Gemini 发起流式请求。
3. Worker 解析 Gemini SSE 中每段增量文本。
4. 每解析到一段文本，就通过自己的 SSE `chunk` 事件写给前端。
5. 前端用 `fetch()` 读取 `ReadableStream`，实时把 Markdown 渲染成 HTML。

长字幕不会一次性塞给模型。服务端会按字幕片段和字符预算切块，默认每块约 `6000` 字符。每个块就是一个章节：Gemini 在该块流式输出中生成 `## 章节标题` 和若干 `### 小标题`，正文根据视频形态自然组织。如果是访谈，会保留说话人；如果是演讲、教程或独白，则使用自然段落。

翻译和 5W1H 请求都关闭了 `thinkingBudget`，减少不必要的推理延迟，更适合“字幕翻译 + 内容整理”这类任务。

## 如何根据用户生成要求影响输出结果

页面提供一个可选的“生成要求”输入框。用户可以输入自然语言约束，例如：

- 任务类型：字幕翻译稿、对话整理稿、面向汇报的内容稿
- 输出风格：克制、口语化、商业分析、适合阅读
- 目标受众：非技术管理者、投资人、产品经理
- 约束条件：重点解释商业模式，不要过度技术化，不要添加外部信息

这些要求会进入主生成 prompt 和每个字幕分块 prompt。模型会在不违背字幕事实、不省略当前字幕块的前提下尽量满足用户要求。

这里的取舍是：用户要求只影响表达方式和组织方式，不允许覆盖字幕事实。也就是说，用户可以要求“写给非技术管理者”，但模型不能因此编造字幕里没有的信息。

## 如何实现章节级 5W1H 总结

章节级 5W1H 在 `src/routes/summary.ts`、`src/services/session.ts` 和前端页面中配合实现。

主文章生成时，服务端会创建一个 session，并保存：

- `sessionId`
- `videoId`
- 原始字幕全文
- 字幕片段
- 用户生成要求
- 已生成文章内容
- 每个章节的 `sectionId`、标题、原字幕、译文和时间范围

每个字幕块生成完成后，服务端解析该块中的 `## 章节标题`，创建一个 section，并通过 SSE `section` 事件把 `sectionId` 发给前端。前端只在有 `sectionId` 的章节标题旁显示 `5W1H` 按钮。

点击按钮时，前端只提交：

```json
{
  "sessionId": "...",
  "sectionId": "section-1"
}
```

前端不会重新提交整篇文章。服务端通过 `sessionId + sectionId` 找回整篇视频上下文和当前章节上下文，再调用 Gemini 普通 `generateContent`，要求返回固定 JSON：

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

前端按固定格式渲染 Who / What / When / Where / Why / How。

当前 session 存储使用 Worker 内存 `Map`，适合笔试演示。生产环境可替换为 Cloudflare KV、D1 或 Durable Object。

## 主要工程取舍和亮点

- **优先保证完整翻译闭环**：早期方案考虑过先抽取代表片段生成概览，但会遗漏长视频内容。最终改为按字幕片段完整切块翻译。
- **章节标题由模型生成，但不额外请求模型**：每个 chunk 的第一行就是 `## 章节标题`，避免“先规划章节、再翻译正文”的额外延迟。
- **主文章严格流式输出**：Gemini 生成一点，Worker 就通过 SSE 返回一点，前端实时渲染。
- **5W1H 不让前端重传全文**：章节上下文保存在服务端 session 中，前端只提交 `sectionId`。
- **多级字幕兜底**：YouTube 直连、Supadata、Webshare 代理、预下载字幕、短版内置字幕依次兜底，降低演示失败概率。
- **Cloudflare Worker 友好**：Gemini 使用 REST API；代理使用 Worker TCP Socket；整体不依赖 Node-only runtime。
- **控制长文本风险**：通过 `TRANSLATION_CHUNK_CHARS` 控制分块大小，降低首包延迟和模型失败率。
- **实现保持轻量**：前端不引入框架，服务端模块按 `routes`、`services`、`fixtures` 拆分，便于评审快速阅读。

## 目录结构

```text
src/
  index.ts                 Worker 入口和路由分发
  routes/
    generate.ts            主文章流式生成接口
    summary.ts             章节 5W1H 接口
  services/
    youtube.ts             YouTube/Supadata/代理字幕获取
    supadata.ts            Supadata API 封装
    proxy.ts               Webshare TCP Socket 代理请求
    gemini.ts              Gemini REST 和 SSE 解析
    prompt.ts              主生成和 5W1H prompt
    transcript.ts          字幕片段标准化和分块
    session.ts             服务端生成上下文保存
  fixtures/
    transcript.ts          短版内置字幕
    downloaded-transcript.ts 示例视频完整字幕备份
  ui/
    home.ts                单页前端 HTML/CSS/JS
```
