import { streamGeminiText, pipeGeminiSseAsText, type Env } from "../services/gemini";
import { assertPost, json } from "../services/http";
import { buildArticlePrompt, buildChunkTranslationPrompt } from "../services/prompt";
import { addSection, appendArticleChunk, createSession } from "../services/session";
import { buildTranscriptChunks, formatTimeRange, type TranscriptChunk } from "../services/transcript";
import { getTranscript } from "../services/youtube";

type GenerateRequest = {
  videoUrl?: string;
  instruction?: string;
};

const GEMINI_FLASH_INPUT_TOKEN_LIMIT = 1_048_576;
const SAFE_CHARS_PER_INPUT_TOKEN = 2;
const DEFAULT_TRANSLATION_CHUNK_CHARS = 6_000;
const MIN_TRANSLATION_CHUNK_CHARS = 2_500;
const MAX_PRACTICAL_TRANSLATION_CHUNK_CHARS = 8_000;

export async function handleGenerate(request: Request, env: Env) {
  const methodError = assertPost(request);
  if (methodError) return methodError;

  const payload = (await request.json().catch(() => null)) as GenerateRequest | null;
  const videoUrl = payload?.videoUrl?.trim();
  if (!videoUrl) return json({ error: "请输入 YouTube 视频链接。" }, { status: 400 });

  let transcript;
  try {
    transcript = await getTranscript(videoUrl, env);
  } catch (error) {
    console.warn("[generate] transcript fetch failed:", error instanceof Error ? error.message : String(error));
  }

  if (!transcript) {
    return json({
      error: "字幕获取失败：YouTube 直连和第三方字幕接口均不可用，请稍后重试或更换视频。"
    }, { status: 502 });
  }
  console.log(
    "[generate] transcript ready:",
    `source=${transcript.source}`,
    `chars=${transcript.transcript.length}`,
    `segments=${transcript.segments?.length ?? 0}`,
    `videoId=${transcript.videoId ?? "(none)"}`
  );

  const session = createSession({
    videoId: transcript.videoId,
    transcript: transcript.transcript,
    segments: transcript.segments,
    userInstruction: payload?.instruction?.trim() ?? "",
    article: ""
  });

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const chunkMaxChars = resolveTranslationChunkChars(env, payload?.instruction);

  void (async () => {
    try {
      await writeEvent(writer, encoder, "meta", {
        sessionId: session.id,
        source: transcript.source,
        videoId: transcript.videoId,
        message: transcript.message
      });

      if (transcript.transcript.length > chunkMaxChars) {
        await streamChunkedTranslation({
          env,
          sessionId: session.id,
          transcript: transcript.transcript,
          segments: transcript.segments,
          instruction: payload?.instruction,
          chunkMaxChars,
          writer,
          encoder
        });
      } else {
        await streamSingleTranslation({
          env,
          sessionId: session.id,
          transcript: transcript.transcript,
          segments: transcript.segments,
          source: transcript.source,
          instruction: payload?.instruction,
          writer,
          encoder
        });
      }

      await writeEvent(writer, encoder, "done", { ok: true });
    } catch (error) {
      console.warn("[generate] stream failed:", error instanceof Error ? error.message : String(error));
      await writeEvent(writer, encoder, "error", {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}

async function streamSingleTranslation(input: {
  env: Env;
  sessionId: string;
  transcript: string;
  segments?: TranscriptChunk["segments"];
  source: string;
  instruction?: string;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  encoder: TextEncoder;
}) {
  const prompt = buildArticlePrompt({
    transcript: input.transcript,
    segments: input.segments,
    userInstruction: input.instruction,
    transcriptSource: input.source
  });

  console.log("[generate] prompt chars:", prompt.length);
  const markdown = await streamPromptToClient({
    env: input.env,
    prompt,
    sessionId: input.sessionId,
    writer: input.writer,
    encoder: input.encoder,
    label: "single"
  });

  for (const parsed of parseMarkdownSections(markdown, input.transcript)) {
    const section = addSection(input.sessionId, parsed);
    if (section) await writeEvent(input.writer, input.encoder, "section", publicSection(section));
  }
}

async function streamChunkedTranslation(input: {
  env: Env;
  sessionId: string;
  transcript: string;
  segments?: TranscriptChunk["segments"];
  instruction?: string;
  chunkMaxChars: number;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  encoder: TextEncoder;
}) {
  const chunks = buildTranscriptChunks({
    transcript: input.transcript,
    segments: input.segments,
    maxChars: input.chunkMaxChars
  });
  console.log(
    "[generate] chunked translation:",
    `chunks=${chunks.length}`,
    `chunkMaxChars=${input.chunkMaxChars}`,
    `modelInputTokenLimit=${GEMINI_FLASH_INPUT_TOKEN_LIMIT}`
  );

  for (const chunk of chunks) {
    await writeEvent(input.writer, input.encoder, "progress", {
      message: "正在翻译"
    });

    const prompt = buildChunkTranslationPrompt({
      chunk,
      totalChunks: chunks.length,
      userInstruction: input.instruction,
      includeHeading: true
    });
    console.log("[generate] chunk prompt chars:", `index=${chunk.index}`, `chars=${prompt.length}`);

    const markdown = await streamPromptToClient({
      env: input.env,
      prompt,
      sessionId: input.sessionId,
      writer: input.writer,
      encoder: input.encoder,
      label: `chunk-${chunk.index + 1}`
    });

    const title = extractFirstHeading(markdown) || buildFallbackChunkTitle(chunk, chunks.length);
    const section = addSection(input.sessionId, {
      title,
      translatedMarkdown: markdown,
      sourceText: chunk.text,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      chunkIndexes: [chunk.index]
    });

    if (section) {
      await writeEvent(input.writer, input.encoder, "section", publicSection(section));
    }

    await writeEvent(input.writer, input.encoder, "chunk", { text: "\n\n" });
    appendArticleChunk(input.sessionId, "\n\n");
  }
}

async function streamPromptToClient(input: {
  env: Env;
  prompt: string;
  sessionId: string;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  encoder: TextEncoder;
  label: string;
}) {
  let chunkCount = 0;
  let streamedChars = 0;
  let markdown = "";

  console.log("[generate] requesting Gemini stream:", input.label);
  const geminiStream = await streamGeminiText(input.env, input.prompt);
  console.log("[generate] Gemini stream opened:", input.label);

  await pipeGeminiSseAsText(geminiStream, async (text) => {
    chunkCount += 1;
    streamedChars += text.length;
    markdown += text;
    if (chunkCount <= 5 || chunkCount % 20 === 0) {
      console.log(
        "[generate] Gemini chunk:",
        `label=${input.label}`,
        `count=${chunkCount}`,
        `chars=${text.length}`,
        `total=${streamedChars}`,
        `preview=${text.slice(0, 80).replace(/\s+/g, " ")}`
      );
    }

    appendArticleChunk(input.sessionId, text);
    await writeEvent(input.writer, input.encoder, "chunk", { text });
  });

  console.log("[generate] Gemini stream completed:", `label=${input.label}`, `chunks=${chunkCount}`, `chars=${streamedChars}`);
  return markdown;
}

function parseMarkdownSections(markdown: string, fallbackSource: string) {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  if (matches.length === 0) {
    return [{
      title: "字幕翻译",
      translatedMarkdown: markdown,
      sourceText: fallbackSource,
      chunkIndexes: [0]
    }];
  }

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? markdown.length;
    return {
      title: match[1].trim(),
      translatedMarkdown: markdown.slice(start, end).trim(),
      sourceText: fallbackSource,
      chunkIndexes: [index]
    };
  });
}

function publicSection(section: { id: string; order: number; title: string }) {
  return {
    id: section.id,
    order: section.order,
    title: section.title
  };
}

function resolveTranslationChunkChars(env: Env, instruction?: string) {
  const configured = Number(env.TRANSLATION_CHUNK_CHARS);
  const practicalTarget = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TRANSLATION_CHUNK_CHARS;
  const promptOverheadChars = buildChunkTranslationPrompt({
    chunk: {
      index: 0,
      text: "",
      segments: []
    },
    totalChunks: 999,
    userInstruction: instruction,
    sectionTitle: "字幕翻译",
    includeHeading: false
  }).length;
  const contextWindowChars = GEMINI_FLASH_INPUT_TOKEN_LIMIT * SAFE_CHARS_PER_INPUT_TOKEN;
  const contextBound = contextWindowChars - promptOverheadChars - 8_000;
  const bounded = Math.min(
    practicalTarget,
    MAX_PRACTICAL_TRANSLATION_CHUNK_CHARS,
    Math.max(MIN_TRANSLATION_CHUNK_CHARS, contextBound)
  );

  return Math.max(MIN_TRANSLATION_CHUNK_CHARS, Math.floor(bounded));
}

function extractFirstHeading(markdown: string) {
  return markdown.match(/^##\s+(.+)$/m)?.[1]?.trim() ?? "";
}

function buildFallbackChunkTitle(chunk: TranscriptChunk, totalChunks: number) {
  const index = String(chunk.index + 1).padStart(2, "0");
  const total = String(totalChunks).padStart(2, "0");
  const timeRange = formatTimeRange(chunk);
  return timeRange
    ? `字幕翻译 ${index}/${total}｜${timeRange}`
    : `字幕翻译 ${index}/${total}`;
}

async function writeEvent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  event: string,
  data: unknown
) {
  await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}
