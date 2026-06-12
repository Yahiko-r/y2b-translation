import { fetchSupadataChineseTranscript, type SupadataEnv } from "./supadata";
import type { TranscriptSegment } from "./transcript";

export type TranscriptResult = {
  source: "youtube" | "supadata";
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

export async function getTranscript(videoUrl: string, env?: SupadataEnv): Promise<TranscriptResult> {
  const videoId = extractVideoId(videoUrl);
  console.log("[youtube] input url:", videoUrl);
  console.log("[youtube] parsed videoId:", videoId ?? "(none)");

  if (!videoId) throw new Error("无法识别 YouTube videoId。");

  try {
    const transcript = await fetchYoutubeTranscript(videoId);
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
    throw new Error(`YouTube 直连与 Supadata 字幕获取均失败：${stringifyError(error)}`);
  }
}

async function fetchYoutubeTranscript(videoId: string) {
  try {
    return await fetchTimedtextTranscript(videoId);
  } catch (error) {
    console.warn("[youtube] timedtext path failed:", stringifyError(error));
    console.log("[youtube] falling back to watch page caption extraction");
  }

  return fetchWatchPageTranscript(videoId);
}

async function fetchTimedtextTranscript(videoId: string) {
  const listUrl = `https://video.google.com/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
  console.log("[youtube] fetching timedtext track list:", listUrl);

  const listResponse = await fetchText(listUrl, "timedtext list", {
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

  const captionResponse = await fetchText(captionUrl, "timedtext caption", {
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

async function fetchWatchPageTranscript(videoId: string) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  console.log("[youtube] fetching watch page:", watchUrl);

  const response = await fetchText(watchUrl, "watch page", {
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
  label: string,
  init: RequestInit = {}
): Promise<{ ok: boolean; status: number; statusText: string; text: string }> {
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
    throw error;
  }
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

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
