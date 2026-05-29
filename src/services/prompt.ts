import { formatTimeRange, type TranscriptChunk, type TranscriptSegment } from "./transcript";

export function buildArticlePrompt(input: {
  transcript: string;
  segments?: TranscriptSegment[];
  userInstruction?: string;
  transcriptSource: string;
}) {
  const extra = input.userInstruction?.trim()
    ? `\n用户额外生成要求：\n${input.userInstruction.trim()}\n`
    : "";

  return `
你是资深中文译者和长内容编辑。请把 YouTube 字幕整理成一篇按章节组织、读起来像自然中文内容稿的翻译稿。

核心要求：
1. 使用简体中文，输出 Markdown，不要输出代码块。
2. 主体任务是“忠实翻译并润色成中文稿”，不是概览、评论、摘要或深度分析。
3. 必须按内容划分章节；每个章节使用 Markdown 二级标题，章节内按话题使用 Markdown 三级小标题。
4. 不要编造字幕之外的信息，不要补充外部背景，不要替说话者增加新观点。
5. 不要逐词硬译。必须按中文表达习惯重组语序、合并断裂短句、改写英语化连接词和抽象名词，让读者能顺畅阅读。
6. 根据视频形态选择正文形式：如果字幕明显是多人访谈或对话，保留 **Name:** 对话格式；如果是演讲、解说、教程或独白，使用自然段落，不要强行编造说话人。
7. 每个章节正文要尽量完整覆盖该章节对应字幕，不要只提炼要点。
8. 不要额外写导语、评论或结尾总结，除非原字幕本身有对应内容。
9. 章节标题和小标题要具体、有信息量，不要使用“第一章”“字幕片段”“内容整理”这类空泛标题。
10. 如果输入字幕被标记为抽取片段，只翻译提供的片段，不要假装覆盖完整视频。
11. 允许压缩明显的口头重复、语气词和自我修正，但要保留强调、转折、因果和关键判断。
12. 避免翻译腔，例如“与之相比的是某些事物”“仅从数量级来看”这类僵硬表达；可以改成“能与它相提并论的，是……”“从影响量级看……”。
${extra}
字幕来源：${input.transcriptSource}

字幕内容：
${input.transcript}
`.trim();
}

export function build5w1hPrompt(input: {
  transcript: string;
  article: string;
  sectionTitle: string;
  sectionMarkdown?: string;
  sectionSourceText?: string;
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

当前章节译文：
${input.sectionMarkdown || "无"}

当前章节原字幕：
${input.sectionSourceText || "无"}

已生成文章：
${input.article}

视频字幕：
${input.transcript}
`.trim();
}

export function buildChunkTranslationPrompt(input: {
  chunk: TranscriptChunk;
  totalChunks: number;
  userInstruction?: string;
  sectionTitle?: string;
  includeHeading?: boolean;
}) {
  const timeRange = formatTimeRange(input.chunk);
  const extra = input.userInstruction?.trim()
    ? `\n用户额外生成要求：\n${input.userInstruction.trim()}\n`
    : "";

  return `
你是资深中文译者和长内容编辑。请把当前字幕分块翻译成自然、顺畅、可直接阅读的中文稿，并输出 Markdown。

当前分块：${input.chunk.index + 1}/${input.totalChunks}
时间范围：${timeRange || "未知"}
当前章节标题参考：${input.sectionTitle || "由你根据当前字幕内容生成"}

核心要求：
1. ${input.includeHeading ? "第一行必须是 Markdown 二级标题，格式为：## 语义章节标题。标题由你根据当前字幕内容生成，8-24 个汉字，具体、有信息量，不要写“字幕片段”“第几段”。" : "不要输出 Markdown 二级章节标题，直接输出正文。"}
2. ${input.includeHeading ? "整个输出只能出现这一个 Markdown 二级标题；章节内部不要再输出其他二级标题。" : "不要输出 Markdown 二级标题。"}
3. ${input.includeHeading ? "章节内必须按内容自然拆成 1-4 个 Markdown 三级小标题，格式为：### 小标题；每个小标题后跟对应正文。" : "如果内容有明显话题切换，可以使用 Markdown 三级小标题分段。"}
4. 小标题要像截图示例那样概括局部话题，例如“AI公司的收入增长与产品演变”“战略选择与风投策略”；不要使用“段落一”“主要内容”等空泛标题。
5. 正文必须按照字幕原有顺序完整翻译当前分块，不要总结、不要省略、不要改写成评论文章。
6. 不要逐词硬译。必须按中文表达习惯重组语序、合并断裂短句、改写英语化连接词和抽象名词，让读者能顺畅阅读。
7. 根据视频形态选择正文形式：如果字幕明显是多人访谈或对话，保留 **Name:** 对话格式；如果是演讲、解说、教程或独白，使用自然段落，不要强行编造说话人。
8. 只翻译当前分块提供的字幕，不要补充外部背景，不要假装覆盖未提供的内容。
9. 输出 Markdown，不要输出 JSON，不要输出代码块。
10. 允许压缩明显的口头重复、语气词和自我修正，但要保留强调、转折、因果和关键判断。
11. 避免翻译腔，例如“与之相比的是某些事物”“仅从数量级来看”这类僵硬表达；可以改成“能与它相提并论的，是……”“从影响量级看……”。
${extra}
当前字幕分块：
${input.chunk.text}
`.trim();
}
