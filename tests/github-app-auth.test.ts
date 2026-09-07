import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InstallationTokenProvider,
  githubAppAuthConfig,
  lookupInstallationIdForRepo,
  mintAppJwt,
  mintInstallationAccessToken,
} from "../src/github-app.js";
import { openTestDb } from "./helpers/db.js";

function testKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("GitHub App installation auth", () => {
  it("reads APP_ID + PRIVATE_KEY (with escaped newlines)", () => {
    const pem = testKeyPem();
    expect(githubAppAuthConfig({} as NodeJS.ProcessEnv)).toBeNull();
    const config = githubAppAuthConfig({
      MEMRACER_GITHUB_APP_ID: "12345",
      MEMRACER_GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
    } as NodeJS.ProcessEnv);
    expect(config?.appId).toBe("12345");
    expect(config?.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(config?.privateKeyPem).not.toContain("\\n");
  });

  it("mints a three-part RS256 App JWT", () => {
    const config = { appId: "99", privateKeyPem: testKeyPem() };
    const jwt = mintAppJwt(config, 1_700_000_000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      iss: string;
      iat: number;
      exp: number;
    };
    expect(payload.iss).toBe("99");
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("mints an installation access token via the App JWT", async () => {
    const config = { appId: "42", privateKeyPem: testKeyPem() };
    let sawAuth = "";
    const minted = await mintInstallationAccessToken(config, "555", async (url, init) => {
      expect(url).toContain("/app/installations/555/access_tokens");
      expect(init?.method).toBe("POST");
      sawAuth = init?.headers?.Authorization ?? "";
      expect(sawAuth.startsWith("Bearer ")).toBe(true);
      expect(sawAuth.split(".")).toHaveLength(3);
      return {
        status: 201,
        json: async () => ({
          token: "ghs_install_1",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        text: async () => "",
      };
    });
    expect(minted.token).toBe("ghs_install_1");
    expect(minted.expiresAt).toBeGreaterThan(Date.now());
  });

  it("looks up installation_id by enrolled project repo full_name", async () => {
    const db = await openTestDb();
    const now = Date.now();
    await db.prepare(
      `INSERT INTO orgs (id, name, created_by, created_at) VALUES ('org1', 'Org', 'user1', ?)`,
    ).run(now);
    await db.prepare(
      `INSERT INTO github_installations
         (installation_id, org_id, account_id, account_login, connected_by, repository_selection, created_at, updated_at)
       VALUES ('777', 'org1', 'acc', 'recallnet', 'user1', 'selected', ?, ?)`,
    ).run(now, now);
    await db.prepare(
      `INSERT INTO projects (id, name, repo) VALUES ('p1', 'P', 'recallnet/memracer')`,
    ).run();
    await db.prepare(
      `INSERT INTO github_project_repos (project_id, installation_id, repository_id, full_name)
       VALUES ('p1', '777', '1', 'recallnet/memracer')`,
    ).run();
    expect(await lookupInstallationIdForRepo(db, "recallnet/memracer")).toBe("777");
    expect(await lookupInstallationIdForRepo(db, "Recallnet/Memracer")).toBe("777");
    expect(await lookupInstallationIdForRepo(db, "other/repo")).toBeNull();
  });

  it("InstallationTokenProvider caches per installation and serves by repo", async () => {
    const config = { appId: "7", privateKeyPem: testKeyPem() };
    let mints = 0;
    const provider = new InstallationTokenProvider(
      config,
      async (repo) => (repo === "o/r" ? "111" : null),
      async () => {
        mints += 1;
        return {
          status: 201,
          json: async () => ({
            token: `ghs_${mints}`,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
          text: async () => "",
        };
      },
    );
    expect(await provider.tokenForRepo("missing/repo")).toBeNull();
    expect(await provider.tokenForRepo("o/r")).toBe("ghs_1");
    expect(await provider.tokenForRepo("o/r")).toBe("ghs_1");
    expect(mints).toBe(1);
    provider.invalidate();
    expect(await provider.tokenForRepo("o/r")).toBe("ghs_2");
    expect(mints).toBe(2);
  });
});
