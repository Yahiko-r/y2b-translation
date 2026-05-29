import type { TranscriptSegment } from "./transcript";

export type SectionContext = {
  id: string;
  order: number;
  title: string;
  sourceText: string;
  translatedMarkdown: string;
  startMs?: number;
  endMs?: number;
  chunkIndexes: number[];
};

export type ArticleSession = {
  id: string;
  videoId: string | null;
  transcript: string;
  segments?: TranscriptSegment[];
  userInstruction: string;
  article: string;
  sections: SectionContext[];
  createdAt: number;
};

const sessions = new Map<string, ArticleSession>();
const MAX_SESSIONS = 50;

export function createSession(data: Omit<ArticleSession, "id" | "createdAt" | "sections"> & {
  sections?: SectionContext[];
}) {
  pruneSessions();
  const id = crypto.randomUUID();
  const session: ArticleSession = {
    ...data,
    id,
    sections: data.sections ?? [],
    createdAt: Date.now()
  };
  sessions.set(id, session);
  return session;
}

export function appendArticleChunk(id: string, chunk: string) {
  const session = sessions.get(id);
  if (session) session.article += chunk;
}

export function addSection(id: string, section: Omit<SectionContext, "id" | "order">) {
  const session = sessions.get(id);
  if (!session) return null;

  const saved: SectionContext = {
    ...section,
    id: `section-${session.sections.length + 1}`,
    order: session.sections.length
  };
  session.sections.push(saved);
  return saved;
}

export function appendSectionMarkdown(id: string, sectionId: string, markdown: string) {
  const session = sessions.get(id);
  const section = session?.sections.find((item) => item.id === sectionId);
  if (section) section.translatedMarkdown += markdown;
}

export function getSession(id: string) {
  return sessions.get(id) ?? null;
}

function pruneSessions() {
  if (sessions.size < MAX_SESSIONS) return;

  const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
  if (oldest) sessions.delete(oldest.id);
}
