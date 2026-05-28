import { segmentsToText, type TranscriptSegment } from "./transcript";

export type SupadataEnv = {
  SUPADATA_API_KEY?: string;
};

type SupadataTranscriptItem = {
  text?: string;
  offset?: number;
  duration?: number;
  lang?: string;
};

type SupadataTranscriptResponse = {
  content?: string | SupadataTranscriptItem[];
  lang?: string;
  availableLangs?: string[];
};

export type SupadataTranscriptResult = {
  transcript: string;
  segments?: TranscriptSegment[];
  lang?: string;
};

type SupadataTranscriptJobResponse = {
  jobId?: string;
  status?: "queued" | "active" | "completed" | "failed";
};

type SupadataTranscriptResultResponse = SupadataTranscriptResponse & {
  status?: "queued" | "active" | "completed" | "failed";
  error?: unknown;
};

const SUPADATA_BASE_URL = "https://api.supadata.ai/v1";
const SUPADATA_TRANSCRIPT_POLL_ATTEMPTS = 10;
const SUPADATA_TRANSCRIPT_POLL_INTERVAL_MS = 1500;

export async function fetchSupadataChineseTranscript(input: {
  videoUrl: string;
  videoId: string;
  env?: SupadataEnv;
}): Promise<SupadataTranscriptResult> {
  if (!input.env?.SUPADATA_API_KEY) {
    throw new Error("SUPADATA_API_KEY is not configured");
  }

  try {
    return await fetchTranscriptWithLanguage(input, "zh");
  } catch (error) {
    console.warn("[supadata] Chinese transcript failed:", stringifyError(error));
    return fetchTranscriptWithLanguage(input, "en");
  }
}

async function fetchTranscriptWithLanguage(input: {
  videoUrl: string;
  videoId: string;
  env?: SupadataEnv;
}, lang: "zh" | "en") {
  const env = input.env;
  if (!env?.SUPADATA_API_KEY) throw new Error("SUPADATA_API_KEY is not configured");

  console.log("[supadata] fetching transcript:", input.videoId, "lang:", lang);

  const url = new URL(`${SUPADATA_BASE_URL}/transcript`);
  url.searchParams.set("url", input.videoUrl);
  url.searchParams.set("lang", lang);
  url.searchParams.set("text", "false");
  url.searchParams.set("chunkSize", "1000");
  url.searchParams.set("mode", "native");

  console.log("[supadata] request url:", redactApiUrl(url));
  const response = await fetch(url.toString(), {
    headers: {
      "x-api-key": env.SUPADATA_API_KEY
    },
    signal: AbortSignal.timeout(30000)
  });

  console.log("[supadata] transcript status:", response.status, response.statusText, "lang:", lang);
  const payloadText = await response.text();
  if (!response.ok) {
    throw new Error(`Supadata transcript failed: ${response.status} ${payloadText.slice(0, 300)}`);
  }

  console.log("[supadata] payload chars:", payloadText.length, "lang:", lang);

  const data = JSON.parse(payloadText) as SupadataTranscriptResponse | SupadataTranscriptJobResponse;
  const result: SupadataTranscriptResponse = "jobId" in data && data.jobId
    ? await waitForTranscriptJob(data.jobId, env)
    : data as SupadataTranscriptResponse;

  console.log("[supadata] result lang:", result.lang ?? "(missing)");
  console.log("[supadata] content type:", Array.isArray(result.content) ? "segments" : typeof result.content);
  console.log("[supadata] available langs:", result.availableLangs?.join(",") || "(missing)");

  const normalized = normalizeSupadataTranscript(result);
  console.log("[supadata] transcript chars:", normalized.transcript.length, "lang:", result.lang ?? lang);
  console.log("[supadata] segment count:", normalized.segments?.length ?? 0);
  console.log("[supadata] transcript preview:", normalized.transcript.slice(0, 240).replace(/\s+/g, " "));

  if (!normalized.transcript) throw new Error("Supadata returned empty transcript");
  return {
    ...normalized,
    lang: result.lang ?? lang
  };
}

function redactApiUrl(url: URL) {
  const copy = new URL(url.toString());
  return copy.toString();
}

async function waitForTranscriptJob(jobId: string, env: SupadataEnv) {
  console.log("[supadata] transcript jobId:", jobId);

  for (let attempt = 1; attempt <= SUPADATA_TRANSCRIPT_POLL_ATTEMPTS; attempt += 1) {
    await sleep(SUPADATA_TRANSCRIPT_POLL_INTERVAL_MS);

    const response = await fetch(`${SUPADATA_BASE_URL}/transcript/${encodeURIComponent(jobId)}`, {
      headers: {
        "x-api-key": env.SUPADATA_API_KEY!
      },
      signal: AbortSignal.timeout(30000)
    });

    console.log("[supadata] transcript result status:", response.status, response.statusText, "attempt:", attempt);
    const payloadText = await response.text();
    if (!response.ok) {
      throw new Error(`Supadata transcript result failed: ${response.status} ${payloadText.slice(0, 300)}`);
    }

    const data = JSON.parse(payloadText) as SupadataTranscriptResultResponse;
    console.log("[supadata] transcript job status:", data.status);

    if (data.status === "completed") return data;
    if (data.status === "failed") throw new Error("Supadata transcript job failed");
    if (!data.status && data.content) return data;
  }

  throw new Error("Supadata transcript job timed out");
}

function normalizeSupadataTranscript(data: SupadataTranscriptResponse | undefined): {
  transcript: string;
  segments?: TranscriptSegment[];
} {
  if (typeof data?.content === "string") return { transcript: data.content.trim() };

  if (Array.isArray(data?.content)) {
    const segments = data.content
      .map((item) => ({
        text: item.text?.trim() ?? "",
        startMs: item.offset,
        durationMs: item.duration,
        lang: item.lang
      }))
      .filter((item) => item.text);

    return {
      transcript: segmentsToText(segments),
      segments
    };
  }

  return { transcript: "" };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
