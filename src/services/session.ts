import type { TranscriptSegment } from "./transcript";

export type ArticleSession = {
  id: string;
  videoId: string | null;
  transcript: string;
  segments?: TranscriptSegment[];
  userInstruction: string;
  article: string;
  createdAt: number;
};

const sessions = new Map<string, ArticleSession>();
const MAX_SESSIONS = 50;

export function createSession(data: Omit<ArticleSession, "id" | "createdAt">) {
  pruneSessions();
  const id = crypto.randomUUID();
  const session: ArticleSession = {
    ...data,
    id,
    createdAt: Date.now()
  };
  sessions.set(id, session);
  return session;
}

export function appendArticleChunk(id: string, chunk: string) {
  const session = sessions.get(id);
  if (session) session.article += chunk;
}

export function getSession(id: string) {
  return sessions.get(id) ?? null;
}

function pruneSessions() {
  if (sessions.size < MAX_SESSIONS) return;

  const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
  if (oldest) sessions.delete(oldest.id);
}
