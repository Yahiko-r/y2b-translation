export type Env = {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  WEBSHARE_PROXY_HOST?: string;
  WEBSHARE_PROXY_HOSTS?: string;
  WEBSHARE_PROXY_PORT?: string;
  WEBSHARE_PROXY_PORTS?: string;
  WEBSHARE_PROXY_USERNAME?: string;
  WEBSHARE_PROXY_PASSWORD?: string;
  SUPADATA_API_KEY?: string;
  TRANSLATION_CHUNK_CHARS?: string;
};

type GeminiChunk = {
  promptFeedback?: unknown;
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

export async function streamGeminiText(env: Env, prompt: string) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const model = env.GEMINI_MODEL || "gemini-3-flash-preview";
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.35,
        topP: 0.9,
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    })
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${text}`);
  }

  return response.body;
}

export async function generateGeminiJson<T>(env: Env, prompt: string): Promise<T> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const model = env.GEMINI_MODEL || "gemini-3-flash-preview";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          thinkingConfig: {
            thinkingBudget: 0
          }
        }
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as GeminiChunk;
  const text = extractText(data);
  return JSON.parse(text) as T;
}

export async function pipeGeminiSseAsText(
  input: ReadableStream<Uint8Array>,
  onText: (text: string) => void | Promise<void>
) {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parsed = extractGeminiPayloads(buffer);
      buffer = parsed.rest;

      for (const payload of parsed.payloads) {
        const text = parseGeminiPayload(payload);
        if (text) await onText(text);
      }
    }

    const tail = decoder.decode();
    if (tail) buffer += tail;
    const parsed = extractGeminiPayloads(buffer);
    for (const payload of parsed.payloads) {
      const text = parseGeminiPayload(payload);
      if (text) await onText(text);
    }
  } finally {
    reader.releaseLock();
  }
}

function extractGeminiPayloads(buffer: string) {
  const compact = buffer
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("");

  const payloads: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let consumed = 0;

  for (let index = 0; index < compact.length; index += 1) {
    const char = compact[index];

    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

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

    if (depth === 0) {
      payloads.push(compact.slice(start, index + 1));
      consumed = index + 1;
      start = -1;
    }
  }

  return {
    payloads,
    rest: compact.slice(consumed)
      ? `data: ${compact.slice(consumed)}`
      : ""
  };
}

function parseGeminiPayload(payload: string) {
  try {
    const chunk = JSON.parse(payload) as GeminiChunk;
    const text = extractText(chunk);
    if (!text) logEmptyGeminiChunk(chunk);
    return text;
  } catch (error) {
    console.warn(
      "[gemini] failed to parse SSE payload:",
      error instanceof Error ? error.message : String(error),
      payload.slice(0, 300)
    );
    return "";
  }
}

function extractText(chunk: GeminiChunk) {
  return (
    chunk.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("") ?? ""
  );
}

function logEmptyGeminiChunk(chunk: GeminiChunk) {
  const candidate = chunk.candidates?.[0];
  if (candidate?.finishReason === "STOP" && !chunk.promptFeedback) return;

  console.warn(
    "[gemini] empty chunk:",
    `candidates=${chunk.candidates?.length ?? 0}`,
    `finishReason=${candidate?.finishReason ?? "(none)"}`,
    `parts=${candidate?.content?.parts?.length ?? 0}`,
    `promptFeedback=${chunk.promptFeedback ? JSON.stringify(chunk.promptFeedback).slice(0, 300) : "(none)"}`
  );
}
