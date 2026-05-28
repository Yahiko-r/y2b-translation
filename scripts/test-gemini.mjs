import { readFileSync } from "node:fs";

const env = loadDotEnv(".dev.vars");
const apiKey = env.GEMINI_API_KEY;
const model = env.GEMINI_MODEL || "gemini-2.0-flash";

if (!apiKey) {
  console.error("Missing GEMINI_API_KEY in .dev.vars");
  process.exit(1);
}

const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const startedAt = Date.now();

console.log("[gemini-test] model:", model);
console.log("[gemini-test] requesting:", url);

try {
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
          parts: [{ text: "hello, reply with one short sentence" }]
        }
      ]
    }),
    signal: AbortSignal.timeout(20000)
  });

  const elapsed = Date.now() - startedAt;
  const text = await response.text();

  console.log("[gemini-test] status:", response.status, response.statusText);
  console.log("[gemini-test] elapsed_ms:", elapsed);
  console.log("[gemini-test] body:", text.slice(0, 2000));
} catch (error) {
  console.error("[gemini-test] failed:", error);
  process.exit(1);
}

function loadDotEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const separator = line.indexOf("=");
          const key = line.slice(0, separator).trim();
          const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
          return [key, value];
        })
    );
  } catch {
    return {};
  }
}
