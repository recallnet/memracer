import { describe, expect, it, vi } from "vitest";
import { baseUrlFromEnv, queueDepth, redeemEnrollment } from "../src/api.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("redeemEnrollment", () => {
  it("POSTs the token and returns the parsed seat", async () => {
    const seat = {
      key: "mzr_live_x",
      keyId: "k1",
      project: "memracer",
      role: "coder",
      mcpUrl: "https://memracer.com/mcp",
    };
    const doFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(200, seat),
    );
    const result = await redeemEnrollment("https://memracer.com", "mzr_enrl_abc", doFetch);
    expect(result).toEqual(seat);
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0]!;
    expect(url).toBe("https://memracer.com/api/enroll/redeem");
    expect(init!.method).toBe("POST");
    expect(init!.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init!.body as string)).toEqual({ token: "mzr_enrl_abc" });
  });

  it("rejects with the server error on non-2xx", async () => {
    const doFetch = vi.fn(async () => jsonResponse(410, { error: "enrollment expired" }));
    await expect(
      redeemEnrollment("https://memracer.com", "tok", doFetch),
    ).rejects.toThrow(/enrollment expired/);
  });
});

describe("baseUrlFromEnv", () => {
  it("defaults to prod", () => {
    expect(baseUrlFromEnv({})).toBe("https://memracer.com");
  });
  it("uses MEMRACER_BASE_URL and strips a trailing slash", () => {
    expect(baseUrlFromEnv({ MEMRACER_BASE_URL: "http://localhost:3000/" })).toBe("http://localhost:3000");
  });
});

describe("queueDepth", () => {
  it("GETs the role-scoped depth with a Bearer token and returns available", async () => {
    const doFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(200, { available: 3 }),
    );
    const n = await queueDepth("https://memracer.com", "seat_tok", "memracer", "coder", doFetch);
    expect(n).toBe(3);
    const [url, init] = doFetch.mock.calls[0]!;
    expect(url).toBe("https://memracer.com/api/p/memracer/queue-depth?role=coder");
    expect(init!.headers).toMatchObject({ Authorization: "Bearer seat_tok" });
  });

  it("throws the server error on non-2xx", async () => {
    const doFetch = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }));
    await expect(
      queueDepth("https://memracer.com", "bad", "memracer", "coder", doFetch),
    ).rejects.toThrow(/unauthorized/);
  });
});
