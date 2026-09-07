// tests/auth.test.ts
//
// resolveMember in the better-auth-only world (#90): a Bearer credential
// resolves only as a better-auth API key. SQLite in-memory — better-auth's
// verified backend (the PGlite pool disables it).
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { apiKeyProjectId, requestSourceIp, resolveMember } from "../src/auth.js";
import { openDb } from "../src/db.js";
import { betterAuthReady, seedMember, grantMembership } from "./helpers/auth.js";

async function seeded(): Promise<{ db: Db; token: string }> {
  const db = openDb(":memory:");
  await betterAuthReady(db);
  await db
    .prepare("INSERT INTO projects (id, name, repo) VALUES ('ingest','Ingest Service','recallnet/ingest-svc')")
    .run();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('beta','Beta')").run();
  const m = await seedMember(db, {
    name: "dana",
    projectId: "ingest",
    projectName: "Ingest Service",
    role: "human",
  });
  await grantMembership(db, m.userId, { projectId: "beta", projectName: "Beta", role: "coder" });
  return { db, token: m.token };
}

describe("resolveMember", () => {
  it("resolves an API key to only its declared project membership", async () => {
    const { db, token } = await seeded();
    const member = await resolveMember(db, `Bearer ${token}`);
    expect(member).not.toBeNull();
    expect(member!.name).toBe("dana");
    expect(member!.memberships).toEqual([
      { projectId: "ingest", projectName: "Ingest Service", repo: "recallnet/ingest-svc", role: "human", orgId: null, orgName: null },
    ]);
    expect(member!.keyId).toEqual(expect.any(String));
    expect(member!.keyName).toBe("dana");
    await db.close();
  });

  it("rejects a verified API key without declared project metadata", async () => {
    const db = openDb(":memory:");
    await betterAuthReady(db);
    await db.prepare("INSERT INTO projects (id, name) VALUES ('ingest','Ingest')").run();
    const legacy = await seedMember(db, {
      name: "legacy",
      projectId: "ingest",
      role: "human",
      projectScopedKey: false,
    });
    expect(await resolveMember(db, `Bearer ${legacy.token}`)).toBeNull();
    await db.close();
  });

  it("rejects stale projects and unknown explicit scopes", async () => {
    const db = openDb(":memory:");
    await betterAuthReady(db);
    await db.prepare("INSERT INTO projects (id, name) VALUES ('ingest','Ingest')").run();
    const member = await seedMember(db, { name: "scoped", projectId: "ingest", role: "human" });

    await db
      .prepare('UPDATE apikey SET metadata = ? WHERE "referenceId" = ?')
      .run(JSON.stringify({ projectId: "removed" }), member.userId);
    expect(await resolveMember(db, `Bearer ${member.token}`)).toBeNull();

    await db
      .prepare('UPDATE apikey SET metadata = ? WHERE "referenceId" = ?')
      .run(JSON.stringify({ scope: "user", projectId: "ingest" }), member.userId);
    expect(await resolveMember(db, `Bearer ${member.token}`)).toBeNull();
    await db.close();
  });

  it("rejects a missing or malformed header", async () => {
    const { db } = await seeded();
    expect(await resolveMember(db, undefined)).toBeNull();
    expect(await resolveMember(db, "tok-h")).toBeNull();
    expect(await resolveMember(db, "Bearer nope")).toBeNull();
    await db.close();
  });

  it("logs an invalid API key with source IP and only a masked prefix", async () => {
    const { db } = await seeded();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const token = "bad-secret-token";
    expect(await resolveMember(db, `Bearer ${token}`, { sourceIp: "203.0.113.9" })).toBeNull();
    const line = log.mock.calls.map((call) => String(call[0])).find((value) => value.startsWith("[auth-api-key-failure]"));
    expect(line).toContain('"source_ip":"203.0.113.9"');
    expect(line).toContain('"key_prefix":"bad-…"');
    expect(line).not.toContain(token);
    log.mockRestore();
    await db.close();
  });
});

describe("requestSourceIp", () => {
  it("prefers Cloudflare, then the first forwarded address, then the socket", () => {
    expect(requestSourceIp({ "cf-connecting-ip": "198.51.100.2", "x-forwarded-for": "198.51.100.3" }, "127.0.0.1")).toBe("198.51.100.2");
    expect(requestSourceIp({ "x-forwarded-for": "198.51.100.3, 10.0.0.1" }, "127.0.0.1")).toBe("198.51.100.3");
    expect(requestSourceIp({}, "127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("apiKeyProjectId", () => {
  it("accepts legacy and double-encoded project metadata but rejects explicit non-project scopes", () => {
    expect(apiKeyProjectId({ projectId: "p" })).toBe("p");
    expect(apiKeyProjectId({ scope: "project", projectId: "p" })).toBe("p");
    expect(apiKeyProjectId(JSON.stringify(JSON.stringify({ scope: "project", projectId: "p" })))).toBe("p");
    expect(apiKeyProjectId({ scope: "global", projectId: "p" })).toBeNull();
    expect(apiKeyProjectId({ scope: "user", projectId: "p" })).toBeNull();
    expect(apiKeyProjectId("not-json")).toBeNull();
  });
});
