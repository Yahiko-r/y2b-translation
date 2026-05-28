import { streamGeminiText, pipeGeminiSseAsText, type Env } from "../services/gemini";
import { assertPost, json } from "../services/http";
import { buildArticlePrompt } from "../services/prompt";
import { appendArticleChunk, createSession } from "../services/session";
import { getTranscript } from "../services/youtube";

type GenerateRequest = {
  videoUrl?: string;
  instruction?: string;
};

export async function handleGenerate(request: Request, env: Env) {
  const methodError = assertPost(request);
  if (methodError) return methodError;

  const payload = (await request.json().catch(() => null)) as GenerateRequest | null;
  const videoUrl = payload?.videoUrl?.trim();
  if (!videoUrl) return json({ error: "请输入 YouTube 视频链接。" }, { status: 400 });

  const transcript = await getTranscript(videoUrl, env);
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

  const prompt = buildArticlePrompt({
    transcript: transcript.transcript,
    segments: transcript.segments,
    userInstruction: payload?.instruction,
    transcriptSource: transcript.source
  });
  console.log("[generate] prompt chars:", prompt.length);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  void (async () => {
    let chunkCount = 0;
    let streamedChars = 0;

    try {
      await writeEvent(writer, encoder, "meta", {
        sessionId: session.id,
        source: transcript.source,
        videoId: transcript.videoId,
        message: transcript.message
      });

      console.log("[generate] requesting Gemini stream");
      const geminiStream = await streamGeminiText(env, prompt);
      console.log("[generate] Gemini stream opened");

      await pipeGeminiSseAsText(geminiStream, async (text) => {
        chunkCount += 1;
        streamedChars += text.length;
        if (chunkCount <= 5 || chunkCount % 20 === 0) {
          console.log(
            "[generate] Gemini chunk:",
            `count=${chunkCount}`,
            `chars=${text.length}`,
            `total=${streamedChars}`,
            `preview=${text.slice(0, 80).replace(/\s+/g, " ")}`
          );
        }

        appendArticleChunk(session.id, text);
        await writeEvent(writer, encoder, "chunk", { text });
      });

      console.log("[generate] Gemini stream completed:", `chunks=${chunkCount}`, `chars=${streamedChars}`);
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

async function writeEvent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  event: string,
  data: unknown
) {
  await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}
