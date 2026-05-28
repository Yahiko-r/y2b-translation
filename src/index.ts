import { handleGenerate } from "./routes/generate";
import { handleSummary } from "./routes/summary";
import { notFound } from "./services/http";
import { type Env } from "./services/gemini";
import { renderHome } from "./ui/home";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderHome(), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname === "/api/generate") return handleGenerate(request, env);
    if (url.pathname === "/api/summary") return handleSummary(request, env);

    return notFound();
  }
};
