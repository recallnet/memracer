import { describe, expect, it, vi } from "vitest";
import { parseFrame, readEventStream, type SseFrame } from "../src/sse.js";

describe("parseFrame", () => {
  it("parses event + data, stripping one leading space per value", () => {
    expect(parseFrame("event: changed\ndata: {\"project\":\"p\"}")).toEqual({
      event: "changed",
      data: '{"project":"p"}',
    });
  });

  it("defaults the event name to message and joins multi-line data", () => {
    expect(parseFrame("data: a\ndata: b")).toEqual({ event: "message", data: "a\nb" });
  });

  it("returns null for a comment/keepalive record (no data line)", () => {
    expect(parseFrame(": keepalive")).toBeNull();
    expect(parseFrame("event: version")).toBeNull();
  });

  it("tolerates CRLF line endings", () => {
    expect(parseFrame("event: changed\r\ndata: x\r")).toEqual({ event: "changed", data: "x" });
  });
});

/** A Response whose body streams the given chunks, for readEventStream. */
function streamResponse(chunks: string[], ok = true, status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return { ok, status, body } as unknown as Response;
}

describe("readEventStream", () => {
  it("sends a Bearer token in the header, never the URL, and yields frames split on blank lines", async () => {
    const frames: SseFrame[] = [];
    const fetchImpl = vi.fn(async () =>
      streamResponse([": connected\n\n", "event: changed\ndata: {\"project\":\"p\"}\n\n", ": keepalive\n\n"]),
    );
    await readEventStream("https://memracer.com/api/p/p/events", "seat_tok", (f) => frames.push(f), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(frames).toEqual([{ event: "changed", data: '{"project":"p"}' }]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://memracer.com/api/p/p/events");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer seat_tok" });
    expect(url).not.toContain("seat_tok");
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    const frames: SseFrame[] = [];
    const fetchImpl = vi.fn(async () => streamResponse(["event: chan", "ged\ndata: x", "\n\n"]));
    await readEventStream("u", "t", (f) => frames.push(f), { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(frames).toEqual([{ event: "changed", data: "x" }]);
  });

  it("throws on a non-2xx response so the caller can reconnect", async () => {
    const fetchImpl = vi.fn(async () => streamResponse([], false, 401));
    await expect(
      readEventStream("u", "t", () => {}, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/401/);
  });
});
