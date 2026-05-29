export function renderHome() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YouTube 对话文章生成器</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f5f1;
      --ink: #202124;
      --muted: #646760;
      --line: #d9d6cc;
      --panel: #fffdf7;
      --accent: #176b87;
      --accent-strong: #0f4d61;
      --soft: #e8f2f3;
      --danger: #9f2d20;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.6;
    }

    .shell {
      width: min(1120px, calc(100vw - 40px));
      margin: 0 auto;
      padding: 32px 0 56px;
    }

    header {
      display: grid;
      gap: 8px;
      margin-bottom: 24px;
    }

    h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 46px);
      line-height: 1.08;
      letter-spacing: 0;
    }

    .lead {
      margin: 0;
      max-width: 760px;
      color: var(--muted);
      font-size: 16px;
    }

    .workspace {
      display: grid;
      grid-template-columns: 380px minmax(0, 1fr);
      gap: 24px;
      align-items: start;
    }

    .composer {
      position: sticky;
      top: 20px;
      display: grid;
      gap: 14px;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }

    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }

    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      font: inherit;
      font-size: 15px;
      outline: none;
      padding: 11px 12px;
    }

    textarea {
      min-height: 132px;
      resize: vertical;
    }

    input:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(23, 107, 135, 0.12);
    }

    button {
      min-height: 42px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: var(--accent);
      color: white;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      transition: background .16s ease, transform .16s ease;
    }

    button:hover { background: var(--accent-strong); }
    button:active { transform: translateY(1px); }
    button:disabled {
      cursor: not-allowed;
      opacity: .62;
      transform: none;
    }

    .status {
      min-height: 22px;
      color: var(--muted);
      font-size: 13px;
    }

    .status.error { color: var(--danger); }

    .article-wrap {
      min-height: 620px;
      padding: 24px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }

    .article {
      max-width: 760px;
    }

    .article:empty::before {
      content: "生成后的中文文章会实时出现在这里。";
      color: var(--muted);
    }

    .article h1 {
      margin: 0 0 18px;
      font-size: 30px;
    }

    .article h2 {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 32px 0 12px;
      padding-top: 20px;
      border-top: 1px solid var(--line);
      font-size: 22px;
      line-height: 1.3;
    }

    .article h2:first-child {
      margin-top: 0;
      padding-top: 0;
      border-top: 0;
    }

    .article h3 {
      margin: 24px 0 8px;
      font-size: 18px;
      line-height: 1.35;
    }

    .summary-button {
      min-height: 28px;
      padding: 0 9px;
      border-color: #bad4d9;
      background: var(--soft);
      color: var(--accent-strong);
      font-size: 12px;
      white-space: nowrap;
    }

    .summary-button:hover {
      background: #d7ebef;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin: 12px 0 18px;
      padding: 14px;
      border: 1px solid #cfe0e2;
      border-radius: 8px;
      background: #f7fbfb;
    }

    .summary div {
      display: grid;
      gap: 3px;
      min-width: 0;
    }

    .summary strong {
      color: var(--accent-strong);
      font-size: 12px;
      text-transform: uppercase;
    }

    .summary span {
      color: var(--ink);
      font-size: 14px;
      overflow-wrap: anywhere;
    }

    .article p {
      margin: 12px 0;
    }

    .article ul, .article ol {
      padding-left: 24px;
    }

    @media (max-width: 880px) {
      .shell {
        width: min(100vw - 28px, 720px);
        padding-top: 22px;
      }

      .workspace {
        grid-template-columns: 1fr;
      }

      .composer {
        position: static;
      }

      .article-wrap {
        padding: 18px;
      }
    }

    @media (max-width: 560px) {
      .summary {
        grid-template-columns: 1fr;
      }

      .article h2 {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <h1>YouTube 对话文章生成器</h1>
      <p class="lead">输入带字幕的视频链接，基于字幕流式生成一篇中文对话内容文章，并支持按章节生成 5W1H 总结。</p>
    </header>

    <section class="workspace">
      <form class="composer" id="composer">
        <label>
          YouTube 视频链接
          <input id="videoUrl" name="videoUrl" value="https://www.youtube.com/watch?v=xRh2sVcNXQ8" autocomplete="off" required>
        </label>

        <label>
          生成要求
          <textarea id="instruction" name="instruction" placeholder="例如：写给非技术管理者，风格克制清晰，重点解释商业模式和基础设施投入。"></textarea>
        </label>

        <button id="submit" type="submit">生成文章</button>
        <div class="status" id="status"></div>
      </form>

      <article class="article-wrap">
        <div class="article" id="article"></div>
      </article>
    </section>
  </main>

  <script>
    const form = document.querySelector("#composer");
    const submit = document.querySelector("#submit");
    const statusEl = document.querySelector("#status");
    const articleEl = document.querySelector("#article");

    let markdown = "";
    let sessionId = "";
    let done = false;
    let sections = [];
    let summaries = {};

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      markdown = "";
      sessionId = "";
      done = false;
      sections = [];
      summaries = {};
      articleEl.innerHTML = "";
      setStatus("正在获取字幕并连接 Gemini...");
      submit.disabled = true;

      try {
        const response = await fetch("/api/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            videoUrl: document.querySelector("#videoUrl").value,
            instruction: document.querySelector("#instruction").value
          })
        });

        if (!response.ok || !response.body) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "生成请求失败");
        }

        await readEventStream(response.body);
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        submit.disabled = false;
      }
    });

    articleEl.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-summary-id]");
      if (!button || !sessionId) return;
      const sectionId = button.dataset.summaryId;
      if (!sectionId) return;
      const title = button.dataset.summaryTitle;
      button.disabled = true;
      button.textContent = "生成中";

      try {
        const response = await fetch("/api/summary", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, sectionId, sectionTitle: title })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "5W1H 生成失败");
        summaries[sectionId] = data;
        articleEl.innerHTML = renderMarkdown(markdown, true);
        button.textContent = "5W1H";
      } catch (error) {
        setStatus(error.message || String(error), true);
        button.textContent = "重试";
      } finally {
        button.disabled = false;
      }
    });

    async function readEventStream(body) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\\n\\n");
        buffer = events.pop() || "";
        for (const eventText of events) handleEvent(eventText);
      }

      if (buffer.trim()) handleEvent(buffer);
    }

    function handleEvent(eventText) {
      const event = eventText.match(/^event: (.+)$/m)?.[1];
      const dataText = eventText.match(/^data: (.+)$/m)?.[1];
      if (!event || !dataText) return;
      const data = JSON.parse(dataText);

      if (event === "meta") {
        sessionId = data.sessionId;
        setStatus(data.message);
      }

      if (event === "chunk") {
        markdown += data.text;
        articleEl.innerHTML = renderMarkdown(markdown, true);
      }

      if (event === "section") {
        sections[data.order] = data;
        articleEl.innerHTML = renderMarkdown(markdown, true);
      }

      if (event === "progress") {
        setStatus(data.message);
      }

      if (event === "done") {
        done = true;
        articleEl.innerHTML = renderMarkdown(markdown, true);
        setStatus("生成完成。点击章节标题旁的 5W1H 可以生成结构化总结。");
      }

      if (event === "error") {
        setStatus(data.error, true);
      }
    }

    function renderMarkdown(source, includeButtons) {
      const lines = source.split(/\\r?\\n/);
      let html = "";
      let inList = false;
      let headingIndex = 0;

      const closeList = () => {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
      };

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          closeList();
          continue;
        }

        if (line.startsWith("## ")) {
          closeList();
          const title = line.slice(3).trim();
          const section = sections[headingIndex] || {};
          const button = includeButtons && section.id
            ? '<button class="summary-button" data-summary-id="' + escapeAttr(section.id || "") + '" data-summary-title="' + escapeAttr(section.title || title) + '" type="button">5W1H</button>'
            : "";
          html += "<h2><span>" + inline(title) + "</span>" + button + "</h2>";
          if (section.id && summaries[section.id]) {
            html += renderSummaryHtml(summaries[section.id]);
          }
          headingIndex += 1;
          continue;
        }

        if (line.startsWith("### ")) {
          closeList();
          html += "<h3>" + inline(line.slice(4)) + "</h3>";
          continue;
        }

        if (line.startsWith("# ")) {
          closeList();
          html += "<h1>" + inline(line.slice(2)) + "</h1>";
          continue;
        }

        if (/^[-*]\\s+/.test(line)) {
          if (!inList) {
            html += "<ul>";
            inList = true;
          }
          html += "<li>" + inline(line.replace(/^[-*]\\s+/, "")) + "</li>";
          continue;
        }

        closeList();
        html += "<p>" + inline(line) + "</p>";
      }

      closeList();
      return html;
    }

    function renderSummaryHtml(data) {
      return '<div class="summary">' + [
        ["Who", data.who],
        ["What", data.what],
        ["When", data.when],
        ["Where", data.where],
        ["Why", data.why],
        ["How", data.how]
      ].map(([label, value]) => "<div><strong>" + label + "</strong><span>" + escapeHtml(value || "未提及") + "</span></div>").join("") + '</div>';
    }

    function inline(value) {
      return escapeHtml(value)
        .replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")
        .replace(new RegExp("\`(.+?)\`", "g"), "<code>$1</code>");
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\\n/g, " ");
    }

    function setStatus(message, isError = false) {
      statusEl.textContent = message;
      statusEl.classList.toggle("error", isError);
    }
  </script>
</body>
</html>`;
}
