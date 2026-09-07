import type { DoFetch } from "./api.js";

/** One decoded Server-Sent Event frame. */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Parse one raw SSE record (the text between blank-line delimiters) into a
 * frame, or null when the record carries no `data:` line (a `: keepalive`
 * comment or a lone id). Follows the SSE line grammar: `event:`/`data:` fields,
 * `:`-prefixed comments ignored, one optional leading space stripped per value.
 */
export function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  let sawData = false;
  for (const line0 of raw.split("\n")) {
    const line = line0.endsWith("\r") ? line0.slice(0, -1) : line0;
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") {
      data.push(value);
      sawData = true;
    }
  }
  return sawData ? { event, data: data.join("\n") } : null;
}

/**
 * Open an SSE stream with a Bearer token and invoke `onFrame` for each event
 * until the server closes it or `signal` aborts. Unlike a browser EventSource,
 * the CLI can send an Authorization header, so the token never rides in the URL
 * query string. Resolves when the stream ends; throws on a non-2xx response so
 * the caller can reconnect.
 */
export async function readEventStream(
  url: string,
  token: string,
  onFrame: (frame: SseFrame) => void,
  opts: { fetchImpl?: DoFetch; signal?: AbortSignal } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`event stream failed (HTTP ${res.status})`);
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = parseFrame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (frame) onFrame(frame);
    }
  }
}
