import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const env = loadDotEnv(".dev.vars");
const apiKey = env.SUPADATA_API_KEY;
const videoUrl = process.argv[2] || "https://www.youtube.com/watch?v=xRh2sVcNXQ8";
const videoId = new URL(videoUrl).searchParams.get("v") || "xRh2sVcNXQ8";

if (!apiKey) {
  console.error("Missing SUPADATA_API_KEY in .dev.vars");
  process.exit(1);
}

const data = await fetchTranscript("zh").catch(async (error) => {
  console.warn("[fixture] zh failed:", error.message);
  return fetchTranscript("en");
});

const segments = Array.isArray(data.content)
  ? data.content.map((item) => ({
      text: item.text || "",
      startMs: item.offset,
      durationMs: item.duration,
      lang: item.lang || data.lang
    })).filter((item) => item.text)
  : [];
const transcript = typeof data.content === "string"
  ? data.content
  : segments.map((item) => item.text).join("\n");

if (!transcript.trim()) {
  console.error("[fixture] Supadata returned an empty transcript");
  process.exit(1);
}

mkdirSync("src/fixtures", { recursive: true });
const outputPath = "src/fixtures/downloaded-transcript.ts";
const source = `import type { TranscriptSegment } from "../services/transcript";

export const DOWNLOADED_TRANSCRIPT_VIDEO_ID = ${JSON.stringify(videoId)};
export const DOWNLOADED_TRANSCRIPT_LANG = ${JSON.stringify(data.lang || "unknown")};
export const DOWNLOADED_TRANSCRIPT_TEXT = ${JSON.stringify(transcript)};
export const DOWNLOADED_TRANSCRIPT_SEGMENTS: TranscriptSegment[] = ${JSON.stringify(segments, null, 2)};
`;

writeFileSync(outputPath, source);
console.log("[fixture] wrote:", outputPath);
console.log("[fixture] chars:", transcript.length, "segments:", segments.length, "lang:", data.lang);

async function fetchTranscript(lang) {
  const url = new URL("https://api.supadata.ai/v1/transcript");
  url.searchParams.set("url", videoUrl);
  url.searchParams.set("lang", lang);
  url.searchParams.set("text", "false");
  url.searchParams.set("chunkSize", "1000");
  url.searchParams.set("mode", "native");

  console.log("[fixture] fetching:", url.toString());
  const response = await fetch(url, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(30000)
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`);

  const payload = JSON.parse(text);
  const transcriptText = typeof payload.content === "string"
    ? payload.content
    : Array.isArray(payload.content)
      ? payload.content.map((item) => item.text || "").join("\n")
      : "";

  console.log(
    "[fixture] response:",
    response.status,
    "requestedLang:",
    lang,
    "resultLang:",
    payload.lang || "unknown",
    "chars:",
    transcriptText.length,
    "segments:",
    Array.isArray(payload.content) ? payload.content.length : 0
  );

  if (!transcriptText.trim()) throw new Error(`empty transcript for lang=${lang}`);

  return payload;
}

function loadDotEnv(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
        return [key, value];
      })
  );
}
