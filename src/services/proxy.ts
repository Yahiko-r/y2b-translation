import { connect } from "cloudflare:sockets";

export type ProxyEnv = {
  WEBSHARE_PROXY_HOST?: string;
  WEBSHARE_PROXY_HOSTS?: string;
  WEBSHARE_PROXY_PORT?: string;
  WEBSHARE_PROXY_PORTS?: string;
  WEBSHARE_PROXY_USERNAME?: string;
  WEBSHARE_PROXY_PASSWORD?: string;
};

export type ProxyTextResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
};

const PROXY_TIMEOUT_MS = 20000;

export function hasWebshareProxy(env?: ProxyEnv) {
  return Boolean(
    (env?.WEBSHARE_PROXY_HOST || env?.WEBSHARE_PROXY_HOSTS) &&
      (env.WEBSHARE_PROXY_PORT || env.WEBSHARE_PROXY_PORTS) &&
      env.WEBSHARE_PROXY_USERNAME &&
      env.WEBSHARE_PROXY_PASSWORD
  );
}

export async function fetchTextViaWebshareProxy(
  targetUrl: string,
  env: ProxyEnv,
  headers: Record<string, string> = {}
): Promise<ProxyTextResponse> {
  if (!hasWebshareProxy(env)) throw new Error("Webshare proxy is not configured");

  const endpoints = getProxyEndpoints(env);
  let lastError: unknown;

  for (const endpoint of endpoints) {
    try {
      return await fetchTextViaProxyEndpoint(targetUrl, env, endpoint, headers);
    } catch (error) {
      lastError = error;
      console.warn(
        "[proxy] endpoint failed:",
        `${endpoint.host}:${endpoint.port}`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function getProxyEndpoints(env: ProxyEnv) {
  const hosts = splitCsv(env.WEBSHARE_PROXY_HOSTS || env.WEBSHARE_PROXY_HOST || "");
  const ports = splitCsv(env.WEBSHARE_PROXY_PORTS || env.WEBSHARE_PROXY_PORT || "");

  return hosts
    .map((host, index) => ({
      host,
      port: Number(ports[index] || ports[0])
    }))
    .filter((endpoint) => endpoint.host && Number.isFinite(endpoint.port));
}

function splitCsv(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function fetchTextViaProxyEndpoint(
  targetUrl: string,
  env: ProxyEnv,
  endpoint: { host: string; port: number },
  headers: Record<string, string>
): Promise<ProxyTextResponse> {
  return withTimeout(PROXY_TIMEOUT_MS, async () => {
    const url = new URL(targetUrl);
    const socket = connect({
      hostname: endpoint.host,
      port: endpoint.port
    }, {
      secureTransport: "starttls",
      allowHalfOpen: true
    });

    await socket.opened;
    console.log(
      "[proxy] connected to Webshare proxy:",
      `${endpoint.host}:${endpoint.port}`
    );

    const proxyWriter = socket.writable.getWriter();
    const proxyReader = socket.readable.getReader();

    console.log("[proxy] sending CONNECT:", `${url.hostname}:443`);
    await proxyWriter.write(new TextEncoder().encode(buildConnectRequest(url, env)));
    const connectResponse = await readHeaders(proxyReader);
    console.log("[proxy] CONNECT status:", connectResponse.status, connectResponse.statusText);
    proxyReader.releaseLock();
    proxyWriter.releaseLock();

    if (connectResponse.status !== 200) {
      throw new Error(`proxy CONNECT failed: ${connectResponse.status} ${connectResponse.statusText}`);
    }

    const tlsSocket = socket.startTls({ expectedServerHostname: url.hostname });
    const tlsWriter = tlsSocket.writable.getWriter();
    const tlsReader = tlsSocket.readable.getReader();

    await tlsWriter.write(new TextEncoder().encode(buildHttpsRequest(url, headers)));
    await tlsWriter.close();

    const chunks = await readAll(tlsReader);
    return parseHttpResponse(concatBytes(chunks));
  });
}

function buildConnectRequest(url: URL, env: ProxyEnv) {
  const auth = btoa(`${env.WEBSHARE_PROXY_USERNAME}:${env.WEBSHARE_PROXY_PASSWORD}`);
  const host = `${url.hostname}:443`;
  return [
    `CONNECT ${host} HTTP/1.1`,
    `Host: ${host}`,
    `Proxy-Authorization: Basic ${auth}`,
    "Proxy-Connection: Keep-Alive",
    "",
    ""
  ].join("\r\n");
}

function buildHttpsRequest(url: URL, headers: Record<string, string>) {
  const requestHeaders = {
    Host: url.host,
    "User-Agent": "Mozilla/5.0",
    Accept: "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Connection: "close",
    ...headers
  };

  const path = `${url.pathname}${url.search}`;
  const lines = [
    `GET ${path || "/"} HTTP/1.1`,
    ...Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`),
    "",
    ""
  ];

  return lines.join("\r\n");
}

async function readHeaders(reader: ReadableStreamDefaultReader): Promise<{
  status: number;
  statusText: string;
}> {
  const chunks: Uint8Array[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      console.log("[proxy] CONNECT response chunk bytes:", value.byteLength);
      chunks.push(value);
    }

    const bytes = concatBytes(chunks);
    const splitAt = indexOfHeaderEnd(bytes);
    if (splitAt >= 0) {
      const headerText = new TextDecoder("utf-8").decode(bytes.slice(0, splitAt));
      const statusLine = headerText.split("\r\n")[0];
      const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)$/);
      if (!statusMatch) throw new Error(`invalid proxy CONNECT status line: ${statusLine}`);

      return {
        status: Number(statusMatch[1]),
        statusText: statusMatch[2] || ""
      };
    }
  }

  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  throw new Error(`proxy CONNECT response missing headers, bytes=${totalBytes}`);
}

async function readAll(reader: ReadableStreamDefaultReader) {
  const chunks: Uint8Array[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  return chunks;
}

function parseHttpResponse(bytes: Uint8Array): ProxyTextResponse {
  const splitAt = indexOfHeaderEnd(bytes);
  if (splitAt < 0) throw new Error("proxy response missing headers");

  const headerText = new TextDecoder("utf-8").decode(bytes.slice(0, splitAt));
  const bodyBytes = bytes.slice(splitAt + 4);
  const [statusLine, ...headerLines] = headerText.split("\r\n");
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)$/);
  if (!statusMatch) throw new Error(`invalid proxy status line: ${statusLine}`);

  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
  }

  const decodedBody = headers.get("transfer-encoding")?.toLowerCase().includes("chunked")
    ? decodeChunkedBody(bodyBytes)
    : bodyBytes;

  return {
    ok: Number(statusMatch[1]) >= 200 && Number(statusMatch[1]) < 300,
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] || "",
    text: new TextDecoder("utf-8").decode(decodedBody)
  };
}

function indexOfHeaderEnd(bytes: Uint8Array) {
  for (let index = 0; index <= bytes.length - 4; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return index;
    }
  }

  return -1;
}

function decodeChunkedBody(bytes: Uint8Array) {
  const chunks: Uint8Array[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const sizeLineEnd = indexOfCrlf(bytes, offset);
    if (sizeLineEnd < 0) break;

    const sizeText = new TextDecoder("utf-8").decode(bytes.slice(offset, sizeLineEnd));
    const size = Number.parseInt(sizeText.split(";")[0], 16);
    if (!Number.isFinite(size) || size < 0) break;
    if (size === 0) break;

    const chunkStart = sizeLineEnd + 2;
    const chunkEnd = chunkStart + size;
    chunks.push(bytes.slice(chunkStart, chunkEnd));
    offset = chunkEnd + 2;
  }

  return concatBytes(chunks);
}

function indexOfCrlf(bytes: Uint8Array, start: number) {
  for (let index = start; index <= bytes.length - 2; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) return index;
  }

  return -1;
}

function concatBytes(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

async function withTimeout<T>(ms: number, task: () => Promise<T>) {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`proxy request timed out after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([task(), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
