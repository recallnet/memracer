import { describe, expect, it, vi, afterEach } from "vitest";
import { refreshGitHubUserAccessToken } from "../src/github-app.js";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("refreshGitHubUserAccessToken", () => {
  it("exchanges a refresh token and defaults expires_in when GitHub omits it", async () => {
    vi.stubEnv("MEMRACER_GITHUB_APP_CLIENT_ID", "cid");
    vi.stubEnv("MEMRACER_GITHUB_APP_CLIENT_SECRET", "csecret");
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      expect(url).toBe("https://github.com/login/oauth/access_token");
      expect(init?.method).toBe("POST");
      const body = String(init?.body);
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("refresh_token=ghr_old");
      expect(body).toContain("client_id=cid");
      return Response.json({
        access_token: "ghu_new",
        refresh_token: "ghr_new",
        expires_in: 28_800,
        refresh_token_expires_in: 15_552_000,
        token_type: "bearer",
      });
    });

    const before = Date.now();
    const tokens = await refreshGitHubUserAccessToken("ghr_old");
    expect(tokens).not.toBeNull();
    expect(tokens!.accessToken).toBe("ghu_new");
    expect(tokens!.refreshToken).toBe("ghr_new");
    expect(tokens!.accessTokenExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 28_800_000 - 1_000);
    expect(tokens!.refreshTokenExpiresAt!.getTime()).toBeGreaterThan(before);
  });

  it("returns null when GitHub reports an OAuth error without throwing", async () => {
    vi.stubEnv("MEMRACER_GITHUB_APP_CLIENT_ID", "cid");
    vi.stubEnv("MEMRACER_GITHUB_APP_CLIENT_SECRET", "csecret");
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: "bad_refresh_token", error_description: "The refresh token is invalid." }),
    );

    expect(await refreshGitHubUserAccessToken("ghr_bad")).toBeNull();
  });

  it("returns null when client credentials are missing", async () => {
    vi.stubEnv("MEMRACER_GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("MEMRACER_GITHUB_APP_CLIENT_SECRET", "");
    const fetchSpy = vi.fn(nativeFetch);
    vi.stubGlobal("fetch", fetchSpy);
    expect(await refreshGitHubUserAccessToken("ghr_x")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
