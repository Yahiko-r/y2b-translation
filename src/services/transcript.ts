export type TranscriptSegment = {
  text: string;
  startMs?: number;
  durationMs?: number;
  lang?: string;
};

export type TranscriptChunk = {
  index: number;
  startMs?: number;
  endMs?: number;
  text: string;
  segments: TranscriptSegment[];
};

export function segmentsToText(segments: TranscriptSegment[]) {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join("\n");
}

export function buildTranscriptChunks(input: {
  transcript: string;
  segments?: TranscriptSegment[];
  maxChars?: number;
}): TranscriptChunk[] {
  const maxChars = input.maxChars ?? 7000;
  if (input.segments?.length) return chunkSegments(input.segments, maxChars);
  return chunkText(input.transcript, maxChars);
}

export function formatTimeRange(chunk: Pick<TranscriptChunk, "startMs" | "endMs">) {
  if (chunk.startMs === undefined) return "";
  return `${formatTime(chunk.startMs)}-${formatTime(chunk.endMs ?? chunk.startMs)}`;
}

export function formatSegmentsForPrompt(segments: TranscriptSegment[], maxChars: number) {
  if (segments.length === 0) return "";

  const chunks = groupSegmentsByTime(segments, 5 * 60 * 1000);
  const selected = selectRepresentativeChunks(chunks, maxChars);

  return selected
    .map((chunk) => {
      const label = chunk.startMs === undefined
        ? `片段 ${chunk.index + 1}`
        : `${formatTime(chunk.startMs)}-${formatTime(chunk.endMs ?? chunk.startMs)}`;
      return `【${label}】\n${segmentsToText(chunk.segments)}`;
    })
    .join("\n\n");
}

type SegmentChunk = {
  index: number;
  startMs?: number;
  endMs?: number;
  segments: TranscriptSegment[];
};

function groupSegmentsByTime(segments: TranscriptSegment[], chunkDurationMs: number) {
  const chunks = new Map<number, SegmentChunk>();

  segments.forEach((segment, fallbackIndex) => {
    const index = segment.startMs === undefined
      ? Math.floor(fallbackIndex / 80)
      : Math.floor(segment.startMs / chunkDurationMs);
    const startMs = segment.startMs;
    const endMs = startMs === undefined ? undefined : startMs + (segment.durationMs ?? 0);
    const existing = chunks.get(index);

    if (existing) {
      existing.segments.push(segment);
      if (startMs !== undefined) existing.startMs = Math.min(existing.startMs ?? startMs, startMs);
      if (endMs !== undefined) existing.endMs = Math.max(existing.endMs ?? endMs, endMs);
      return;
    }

    chunks.set(index, {
      index,
      startMs,
      endMs,
      segments: [segment]
    });
  });

  return [...chunks.values()].sort((a, b) => a.index - b.index);
}

function selectRepresentativeChunks(chunks: SegmentChunk[], maxChars: number) {
  if (chunks.length <= 3) return fitChunks(chunks, maxChars);

  const selectedIndexes = new Set([
    0,
    Math.floor(chunks.length / 2),
    chunks.length - 1
  ]);

  return fitChunks(
    chunks.filter((_, index) => selectedIndexes.has(index)),
    maxChars
  );
}

function fitChunks(chunks: SegmentChunk[], maxChars: number) {
  const result: SegmentChunk[] = [];
  let used = 0;

  for (const chunk of chunks) {
    const text = segmentsToText(chunk.segments);
    const remaining = Math.max(0, maxChars - used);
    if (remaining <= 0) break;

    if (text.length <= remaining) {
      result.push(chunk);
      used += text.length;
    } else {
      result.push({
        ...chunk,
        segments: [{ text: text.slice(0, remaining) }]
      });
      break;
    }
  }

  return result;
}

function chunkSegments(segments: TranscriptSegment[], maxChars: number) {
  const chunks: TranscriptChunk[] = [];
  let current: TranscriptSegment[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const startMs = current.find((segment) => segment.startMs !== undefined)?.startMs;
    const lastWithTime = [...current].reverse().find((segment) => segment.startMs !== undefined);
    const endMs = lastWithTime?.startMs === undefined
      ? undefined
      : lastWithTime.startMs + (lastWithTime.durationMs ?? 0);

    chunks.push({
      index: chunks.length,
      startMs,
      endMs,
      segments: current,
      text: segmentsToText(current)
    });
    current = [];
    currentChars = 0;
  };

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    if (current.length > 0 && currentChars + text.length > maxChars) flush();
    current.push(segment);
    currentChars += text.length;
  }

  flush();
  return chunks;
}

function chunkText(transcript: string, maxChars: number) {
  const lines = transcript.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const chunks: TranscriptChunk[] = [];
  let current: string[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.join("\n");
    chunks.push({
      index: chunks.length,
      text,
      segments: [{ text }]
    });
    current = [];
    currentChars = 0;
  };

  for (const line of lines) {
    if (current.length > 0 && currentChars + line.length > maxChars) flush();
    current.push(line);
    currentChars += line.length;
  }

  flush();
  return chunks;
}

export function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
