import { formatSegmentsForPrompt, type TranscriptSegment } from "./transcript";

export function buildArticlePrompt(input: {
  transcript: string;
  segments?: TranscriptSegment[];
  userInstruction?: string;
  transcriptSource: string;
}) {
  const preparedTranscript = prepareTranscript(input.transcript, input.segments);
  const extra = input.userInstruction?.trim()
    ? `\n用户额外生成要求：\n${input.userInstruction.trim()}\n`
    : "";

  return `
你是中文科技内容编辑。请基于 YouTube 字幕生成一篇中文视频对话内容文章。

核心要求：
1. 使用简体中文。
2. 输出 Markdown，不要输出代码块。
3. 文章需要按章节组织，每个章节使用二级标题。
4. 保留对话内容的思想和信息密度，但不要逐字翻译。
5. 需要有清晰标题、导语、章节正文和结尾总结。
6. 不编造字幕之外的具体事实。如果字幕信息不足，可以用谨慎措辞。
7. 章节标题要具体，不要使用“第一章”“第二章”这类空泛标题。
${extra}
字幕来源：${input.transcriptSource}

字幕内容：
${preparedTranscript}
`.trim();
}

export function build5w1hPrompt(input: {
  transcript: string;
  article: string;
  sectionTitle: string;
  userInstruction?: string;
}) {
  return `
你是信息抽取助手。请结合整篇视频字幕、已生成文章，以及当前章节标题，为该章节生成 5W1H 总结。

必须只返回 JSON，不要 Markdown，不要解释。JSON 字段固定为：
{
  "who": "string",
  "what": "string",
  "when": "string",
  "where": "string",
  "why": "string",
  "how": "string"
}

用户生成要求：
${input.userInstruction?.trim() || "无"}

当前章节：
${input.sectionTitle}

已生成文章：
${input.article}

视频字幕：
${input.transcript}
`.trim();
}

const MAX_TRANSCRIPT_CHARS_FOR_ARTICLE = 36000;

function prepareTranscript(transcript: string, segments?: TranscriptSegment[]) {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS_FOR_ARTICLE) return transcript;

  if (segments?.length) {
    return [
      `[字幕过长，已按时间片段抽取代表性内容用于演示生成。原始字幕约 ${transcript.length} 字符，${segments.length} 个字幕片段。]`,
      "",
      formatSegmentsForPrompt(segments, MAX_TRANSCRIPT_CHARS_FOR_ARTICLE)
    ].join("\n");
  }

  const headLength = 16000;
  const middleLength = 10000;
  const tailLength = 10000;
  const middleStart = Math.max(0, Math.floor(transcript.length / 2 - middleLength / 2));

  return [
    `[字幕过长，已抽取开头、中段和结尾用于演示生成。原始字幕约 ${transcript.length} 字符。]`,
    "",
    "【开头】",
    transcript.slice(0, headLength),
    "",
    "【中段】",
    transcript.slice(middleStart, middleStart + middleLength),
    "",
    "【结尾】",
    transcript.slice(-tailLength)
  ].join("\n");
}
