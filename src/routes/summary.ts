import { generateGeminiJson, type Env } from "../services/gemini";
import { assertPost, json } from "../services/http";
import { build5w1hPrompt } from "../services/prompt";
import { getSession } from "../services/session";

type SummaryRequest = {
  sessionId?: string;
  sectionId?: string;
  sectionTitle?: string;
};

type SummaryResponse = {
  who: string;
  what: string;
  when: string;
  where: string;
  why: string;
  how: string;
};

export async function handleSummary(request: Request, env: Env) {
  const methodError = assertPost(request);
  if (methodError) return methodError;

  const payload = (await request.json().catch(() => null)) as SummaryRequest | null;
  const sessionId = payload?.sessionId?.trim();
  const sectionId = payload?.sectionId?.trim();
  const sectionTitle = payload?.sectionTitle?.trim();

  if (!sessionId || (!sectionId && !sectionTitle)) {
    return json({ error: "缺少 sessionId 或 sectionId。" }, { status: 400 });
  }

  const session = getSession(sessionId);
  if (!session) {
    return json({ error: "生成上下文已过期，请重新生成文章。" }, { status: 404 });
  }

  const section = sectionId
    ? session.sections.find((item) => item.id === sectionId)
    : session.sections.find((item) => item.title === sectionTitle);

  if (!section) {
    return json({ error: "章节上下文不存在，请重新生成文章。" }, { status: 404 });
  }

  const result = await generateGeminiJson<SummaryResponse>(
    env,
    build5w1hPrompt({
      transcript: session.transcript,
      article: session.article,
      sectionTitle: section.title,
      sectionMarkdown: section.translatedMarkdown,
      sectionSourceText: section.sourceText,
      userInstruction: session.userInstruction
    })
  );

  return json(result);
}
