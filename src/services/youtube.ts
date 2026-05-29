import { FALLBACK_TRANSCRIPT, FALLBACK_VIDEO_URL } from "../fixtures/transcript";
import {
  DOWNLOADED_TRANSCRIPT_SEGMENTS,
  DOWNLOADED_TRANSCRIPT_TEXT,
  DOWNLOADED_TRANSCRIPT_VIDEO_ID
} from "../fixtures/downloaded-transcript";
import {
  fetchTextViaWebshareProxy,
  hasWebshareProxy,
  type ProxyEnv,
  type ProxyTextResponse
} from "./proxy";
import { fetchSupadataChineseTranscript, type SupadataEnv } from "./supadata";
import type { TranscriptSegment } from "./transcript";

export type TranscriptResult = {
  source: "youtube" | "supadata" | "fallback";
  videoId: string | null;
  transcript: string;
  segments?: TranscriptSegment[];
  message: string;
};

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const CAPTION_FETCH_TIMEOUT_MS = 5000;

export function extractVideoId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (!YOUTUBE_HOSTS.has(url.hostname)) return null;
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] ?? null;
    return url.searchParams.get("v");
  } catch {
    const match = input.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{8,})/);
    return match?.[1] ?? null;
  }
}

type TranscriptEnv = ProxyEnv & SupadataEnv;

export async function getTranscript(videoUrl: string, env?: TranscriptEnv): Promise<TranscriptResult> {
  const videoId = extractVideoId(videoUrl);
  console.log("[youtube] input url:", videoUrl);
  console.log("[youtube] parsed videoId:", videoId ?? "(none)");

  if (!videoId) return fallback(null, "无法识别 YouTube videoId，已使用内置示例字幕。");

  try {
    const transcript = await fetchYoutubeTranscript(videoId, undefined);
    console.log("[youtube] transcript fetched successfully, chars:", transcript.length);
    return {
      source: "youtube",
      videoId,
      transcript,
      message: "已成功获取 YouTube 字幕。"
    };
  } catch (error) {
    console.warn("[youtube] direct transcript fetch failed:", stringifyError(error));
  }

  try {
    const transcript = await fetchSupadataChineseTranscript({ videoUrl, videoId, env });
    return {
      source: "supadata",
      videoId,
      transcript: transcript.transcript,
      segments: transcript.segments,
      message: "直连 YouTube 字幕失败，已通过 Supadata 获取字幕。"
    };
  } catch (error) {
    console.warn("[supadata] transcript fetch failed:", stringifyError(error));
  }

  try {
    const transcript = await fetchYoutubeTranscript(videoId, env);
    console.log("[youtube] proxy transcript fetched successfully, chars:", transcript.length);
    return {
      source: "youtube",
      videoId,
      transcript,
      message: "直连与 Supadata 获取失败，已通过代理获取 YouTube 字幕。"
    };
  } catch (error) {
    console.warn("[youtube] proxy transcript fetch failed:", stringifyError(error));
    return fallback(videoId, `YouTube/Supadata 字幕获取失败，已使用内置示例字幕。原因：${stringifyError(error)}`);
  }
}

async function fetchYoutubeTranscript(videoId: string, env?: ProxyEnv) {
  try {
    return await fetchTimedtextTranscript(videoId, env);
  } catch (error) {
    console.warn("[youtube] timedtext path failed:", stringifyError(error));
    console.log("[youtube] falling back to watch page caption extraction");
  }

  return fetchWatchPageTranscript(videoId, env);
}

async function fetchTimedtextTranscript(videoId: string, env?: ProxyEnv) {
  const listUrl = `https://video.google.com/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
  console.log("[youtube] fetching timedtext track list:", listUrl);

  const listResponse = await fetchText(listUrl, env, "timedtext list", {
    headers: {
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": "Mozilla/5.0"
    }
  });

  console.log("[youtube] timedtext list status:", listResponse.status, listResponse.statusText);
  if (!listResponse.ok) throw new Error(`timedtext list ${listResponse.status}`);

  const listXml = listResponse.text;
  console.log("[youtube] timedtext list chars:", listXml.length);

  const tracks = parseTimedtextTracks(listXml);
  if (tracks.length === 0) throw new Error("timedtext list has no tracks");

  console.log(
    "[youtube] timedtext tracks:",
    tracks.map(describeTimedtextTrack).join(" | ")
  );

  const track = chooseTimedtextTrack(tracks);
  console.log("[youtube] selected timedtext track:", describeTimedtextTrack(track));

  const captionUrl = buildTimedtextCaptionUrl(videoId, track);
  console.log("[youtube] fetching timedtext caption:", redactUrl(captionUrl));

  const captionResponse = await fetchText(captionUrl, env, "timedtext caption", {
    headers: { "user-agent": "Mozilla/5.0" }
  });

  console.log("[youtube] timedtext caption status:", captionResponse.status, captionResponse.statusText);
  if (!captionResponse.ok) throw new Error(`timedtext caption ${captionResponse.status}`);

  const captionText = captionResponse.text;
  console.log("[youtube] timedtext caption payload chars:", captionText.length);

  const transcript = captionText.trim().startsWith("{")
    ? parseCaptionJson3(captionText)
    : parseCaptionXml(captionText);

  console.log("[youtube] timedtext transcript chars:", transcript.length);
  if (!transcript) throw new Error("empty timedtext caption text");

  return transcript;
}

async function fetchWatchPageTranscript(videoId: string, env?: ProxyEnv) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  console.log("[youtube] fetching watch page:", watchUrl);

  const response = await fetchText(watchUrl, env, "watch page", {
    headers: {
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": "Mozilla/5.0"
    }
  });

  console.log("[youtube] watch page status:", response.status, response.statusText);
  if (!response.ok) throw new Error(`watch page ${response.status}`);

  const html = response.text;
  console.log("[youtube] watch page html chars:", html.length);

  const playerResponse = parseInitialPlayerResponse(html);
  console.log("[youtube] ytInitialPlayerResponse parsed");

  const tracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ??
    parseCaptionTracksFromHtml(html);

  if (!Array.isArray(tracks) || tracks.length === 0) {
    console.log("[youtube] playability status:", playerResponse?.playabilityStatus?.status ?? "unknown");
    console.log("[youtube] playability reason:", playerResponse?.playabilityStatus?.reason ?? "none");
    console.warn("[youtube] no captionTracks found");
    throw new Error("no caption tracks");
  }

  console.log(
    "[youtube] caption tracks:",
    tracks.map(describeCaptionTrack).join(" | ")
  );

  const track = chooseCaptionTrack(tracks);
  if (!track?.baseUrl) throw new Error("caption baseUrl missing");
  console.log("[youtube] selected caption track:", describeCaptionTrack(track));

  const captionResponse = await fetch(track.baseUrl, {
    signal: AbortSignal.timeout(CAPTION_FETCH_TIMEOUT_MS)
  });

  console.log("[youtube] caption response status:", captionResponse.status, captionResponse.statusText);
  if (!captionResponse.ok) throw new Error(`caption ${captionResponse.status}`);

  const captionText = await captionResponse.text();
  console.log("[youtube] caption payload chars:", captionText.length);

  const transcript = parseCaptionXml(captionText);
  console.log("[youtube] parsed transcript chars:", transcript.length);

  if (!transcript) throw new Error("empty caption text");

  return transcript;
}

async function fetchText(
  url: string,
  env: ProxyEnv | undefined,
  label: string,
  init: RequestInit = {}
): Promise<ProxyTextResponse> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(CAPTION_FETCH_TIMEOUT_MS)
    });

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text
    };
  } catch (error) {
    console.warn(`[youtube] direct fetch failed for ${label}:`, stringifyError(error));
    if (!hasWebshareProxy(env)) throw error;

    console.log(`[youtube] retrying ${label} through Webshare proxy`);
    return fetchTextViaWebshareProxy(url, env!, normalizeHeaders(init.headers));
  }
}

function normalizeHeaders(headers: HeadersInit | undefined) {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const values: Record<string, string> = {};
    headers.forEach((value, key) => {
      values[key] = value;
    });
    return values;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

type TimedtextTrack = {
  langCode: string;
  name?: string;
  kind?: string;
  displayName?: string;
};

function parseInitialPlayerResponse(html: string): any {
  const marker = "ytInitialPlayerResponse = ";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("ytInitialPlayerResponse not found");

  const jsonStart = start + marker.length;
  const jsonEnd = findJsonEnd(html, jsonStart);
  if (jsonEnd < 0) throw new Error("ytInitialPlayerResponse parse failed");

  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

function parseCaptionTracksFromHtml(html: string): any[] | null {
  const marker = "\"captionTracks\":";
  const markerStart = html.indexOf(marker);
  if (markerStart < 0) {
    console.log("[youtube] captionTracks marker not found in html");
    return null;
  }

  const arrayStart = html.indexOf("[", markerStart + marker.length);
  if (arrayStart < 0) {
    console.log("[youtube] captionTracks array start not found");
    return null;
  }

  const arrayEnd = findJsonArrayEnd(html, arrayStart);
  if (arrayEnd < 0) {
    console.log("[youtube] captionTracks array end not found");
    return null;
  }

  try {
    const raw = html.slice(arrayStart, arrayEnd);
    const unescaped = raw
      .replace(/\\"/g, "\"")
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/");

    const tracks = JSON.parse(unescaped);
    console.log("[youtube] captionTracks parsed from html marker");
    return tracks;
  } catch (error) {
    console.warn("[youtube] captionTracks html marker parse failed:", stringifyError(error));
    return null;
  }
}

function findJsonEnd(text: string, start: number) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") inString = true;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0 && char === "}") return index + 1;
  }

  return -1;
}

function findJsonArrayEnd(text: string, start: number) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") inString = true;
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (depth === 0 && char === "]") return index + 1;
  }

  return -1;
}

function chooseCaptionTrack(tracks: any[]) {
  const preferred = ["zh-CN", "zh-Hans", "zh", "en"];
  return (
    preferred
      .map((code) => tracks.find((track) => track.languageCode === code))
      .find(Boolean) ?? tracks[0]
  );
}

function parseTimedtextTracks(xml: string): TimedtextTrack[] {
  return [...xml.matchAll(/<track\b([^>]*)\/?>/g)]
    .map((match) => parseTimedtextTrackAttrs(match[1]))
    .filter((track): track is TimedtextTrack => Boolean(track?.langCode));
}

function parseTimedtextTrackAttrs(attrs: string): TimedtextTrack | null {
  const values = Object.fromEntries(
    [...attrs.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [
      match[1],
      decodeEntities(match[2])
    ])
  );

  const langCode = values.lang_code;
  if (!langCode) return null;

  return {
    langCode,
    name: values.name,
    kind: values.kind,
    displayName: values.lang_translated || values.lang_original
  };
}

function chooseTimedtextTrack(tracks: TimedtextTrack[]) {
  const preferred = ["zh-CN", "zh-Hans", "zh", "en"];
  return (
    preferred
      .map((code) => tracks.find((track) => track.langCode === code))
      .find(Boolean) ?? tracks[0]
  );
}

function buildTimedtextCaptionUrl(videoId: string, track: TimedtextTrack) {
  const url = new URL("https://video.google.com/timedtext");
  url.searchParams.set("v", videoId);
  url.searchParams.set("lang", track.langCode);
  url.searchParams.set("fmt", "json3");
  if (track.name) url.searchParams.set("name", track.name);
  if (track.kind) url.searchParams.set("kind", track.kind);
  return url.toString();
}

function describeTimedtextTrack(track: TimedtextTrack) {
  return [
    `lang=${track.langCode}`,
    `kind=${track.kind ?? "manual"}`,
    `name=${track.name || "default"}`,
    `display=${track.displayName || "unknown"}`
  ].join(",");
}

function redactUrl(url: string) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}?${parsed.searchParams.toString()}`;
}

function describeCaptionTrack(track: any) {
  const name = track.name?.simpleText ?? track.name?.runs?.map((run: any) => run.text).join("") ?? "unknown";
  return [
    `lang=${track.languageCode ?? "unknown"}`,
    `kind=${track.kind ?? "manual"}`,
    `name=${name}`,
    `baseUrl=${track.baseUrl ? "yes" : "no"}`
  ].join(",");
}

function parseCaptionXml(xml: string) {
  return [...xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((match) => decodeEntities(stripTags(match[1])).trim())
    .filter(Boolean)
    .join("\n");
}

function parseCaptionJson3(json: string) {
  const data = JSON.parse(json) as {
    events?: Array<{ segs?: Array<{ utf8?: string }> }>;
  };

  return (
    data.events
      ?.map((event) => event.segs?.map((seg) => seg.utf8 ?? "").join("") ?? "")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n") ?? ""
  );
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, "");
}

function decodeEntities(value: string) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function fallback(videoId: string | null, message: string): TranscriptResult {
  if (
    videoId &&
    videoId === DOWNLOADED_TRANSCRIPT_VIDEO_ID &&
    DOWNLOADED_TRANSCRIPT_TEXT.trim()
  ) {
    console.log(
      "[fallback] using downloaded transcript fixture:",
      videoId,
      "chars:",
      DOWNLOADED_TRANSCRIPT_TEXT.length,
      "segments:",
      DOWNLOADED_TRANSCRIPT_SEGMENTS.length
    );

    return {
      source: "fallback",
      videoId,
      transcript: DOWNLOADED_TRANSCRIPT_TEXT,
      segments: DOWNLOADED_TRANSCRIPT_SEGMENTS,
      message: `${message} 已使用 Supadata 预下载硬编码字幕：${FALLBACK_VIDEO_URL}`
    };
  }

  console.log("[fallback] using short built-in sample transcript");

  return {
    source: "fallback",
    videoId,
    transcript: FALLBACK_TRANSCRIPT,
    message: `${message} 示例视频：${FALLBACK_VIDEO_URL}`
  };
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
