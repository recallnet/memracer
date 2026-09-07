// tests/onboarding.test.ts
//
// Task #78: the real onboarding + team-management loop on the better-auth
// backend. A brand-new email sign-up creates an org and a project, invites a
// teammate, changes roles, and mints an API key — all through the dashboard
// write routes, with role enforcement sourced from better-auth org membership
// (not the legacy members/memberships table). Plus the legacy-token cutover:
// with MEMRACER_LEGACY_TOKENS off, a seeded static token no longer resolves
// while session + API-key auth keep working.
//
// SQLite in-memory (better-auth's verified backend); openDb directly, since the
// PGlite test pool disables better-auth.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { resolveMember } from "../src/auth.js";
import { authReady, repairLegacyProjectAdminRoles } from "../src/auth/instance.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { magicLinkSessionCookie } from "./helpers/auth.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let dbRef: Db;

beforeEach(async () => {
  dbRef = openDb(":memory:");
  await authReady(dbRef);
  const made = createApp(dbRef, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
    sseKeepaliveMs: 40,
  });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await dbRef.close();
});

/** Create the better-auth user through the passwordless flow and return its session cookie. */
async function signUpAndIn(email: string, name: string): Promise<string> {
  return magicLinkSessionCookie(dbRef, email, name);
}

function req(path: string, cookie: string, body?: unknown, method = "POST"): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function getJson(path: string, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { cookie } });
}

/** Full onboarding for a fresh user: sign in, create an org, create a project. Returns {cookie, orgId, projectId}. */
async function onboard(
  email: string,
  name: string,
  orgName: string,
  projectName: string,
): Promise<{ cookie: string; orgId: string; projectId: string }> {
  const cookie = await signUpAndIn(email, name);
  const orgRes = await req("/api/orgs", cookie, { name: orgName });
  const org = (await orgRes.json()) as { id: string };
  const projRes = await req(`/api/orgs/${org.id}/projects`, cookie, {
    name: projectName,
    repo: "acme/thing",
  });
  const proj = (await projRes.json()) as { id: string };
  return { cookie, orgId: org.id, projectId: proj.id };
}

/** Paid subscription required before invites (no free multi-seat tier). */
async function activateBilling(orgId: string, seats = 50): Promise<void> {
  await dbRef
    .prepare(
      "UPDATE orgs SET plan = ?, seat_quantity = ?, billing_status = ? WHERE id = ?",
    )
    .run("team", seats, "active", orgId);
}

describe("#78 onboarding — a fresh sign-up bootstraps its own org, project, and admin membership", () => {
  it("a signed-in user with no membership is identified by /api/session but has no projects yet", async () => {
    const cookie = await signUpAndIn("fresh@acme.test", "Fresh Person");
    const sess = await getJson("/api/session", cookie);
    expect(sess.status).toBe(200);
    expect((await sess.json()).name).toBe("Fresh Person");
    // no membership yet → /api/projects is empty (not a hard 401 that bounces to the gate)
    const proj = await getJson("/api/projects", cookie);
    expect(proj.status).toBe(200);
    expect((await proj.json()).projects).toEqual([]);
  });

  it("gates Project creation to the Org creator or a sibling-Project member", async () => {
    const owner = await onboard("org-owner@acme.test", "Org Owner", "Acme Org", "Widgets");
    await activateBilling(owner.orgId);
    const invitation = await req(`/api/p/${owner.projectId}/invite`, owner.cookie, {
      email: "org-member@acme.test",
    });
    const { inviteUrl } = (await invitation.json()) as { inviteUrl: string };
    const memberCookie = cookieFrom(await acceptInvite(inviteUrl));

    const sibling = await req(`/api/orgs/${owner.orgId}/projects`, memberCookie, { name: "Sibling Project" });
    expect(sibling.status).toBe(200);
    const siblingId = ((await sibling.json()) as { id: string }).id;
    const memberId = (await dbRef
      .prepare('SELECT id FROM "user" WHERE email = ?')
      .get<{ id: string }>("org-member@acme.test"))!.id;
    expect(await dbRef
      .prepare('SELECT role FROM "member" WHERE "organizationId" = ? AND "userId" = ?')
      .get(siblingId, memberId)).toMatchObject({ role: "admin" });

    const outsiderCookie = await signUpAndIn("outsider@acme.test", "Outsider");
    const otherOrg = await req("/api/orgs", outsiderCookie, { name: "Other Org" });
    expect(otherOrg.status).toBe(200);
    expect((await req(`/api/orgs/${owner.orgId}/projects`, outsiderCookie, { name: "Intruder" })).status).toBe(403);
    expect((await req("/api/orgs/missing/projects", outsiderCookie, { name: "Nowhere" })).status).toBe(404);
  });

  it("returns an authorized flat Org roster and hides foreign or missing Orgs", async () => {
    const owner = await onboard("roster-owner@acme.test", "Roster Owner", "Roster Org", "Widgets");
    await activateBilling(owner.orgId);
    const second = await req(`/api/orgs/${owner.orgId}/projects`, owner.cookie, { name: "Gadgets" });
    expect(second.status).toBe(200);
    const secondId = ((await second.json()) as { id: string }).id;
    const invitation = await req(`/api/p/${owner.projectId}/invite`, owner.cookie, {
      email: "roster-member@acme.test",
    });
    const { inviteUrl } = (await invitation.json()) as { inviteUrl: string };
    const memberCookie = cookieFrom(await acceptInvite(inviteUrl));

    const rosterRes = await getJson(`/api/orgs/${owner.orgId}/roster`, memberCookie);
    expect(rosterRes.status).toBe(200);
    const roster = (await rosterRes.json()) as {
      org: { id: string; name: string };
      members: Array<{
        userId: string; name: string; email: string; projectId: string; projectName: string; role: string;
      }>;
    };
    expect(roster.org).toEqual({ id: owner.orgId, name: "Roster Org" });
    expect(roster.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Roster Owner", projectId: owner.projectId, projectName: "Widgets", role: "admin" }),
      expect.objectContaining({ name: "Roster Owner", projectId: secondId, projectName: "Gadgets", role: "admin" }),
      expect.objectContaining({ name: "roster-member", email: "roster-member@acme.test", projectId: owner.projectId, projectName: "Widgets", role: "human" }),
    ]));
    expect(roster.members).toHaveLength(3);

    const outsiderCookie = await signUpAndIn("roster-outsider@acme.test", "Roster Outsider");
    expect((await getJson(`/api/orgs/${owner.orgId}/roster`, outsiderCookie)).status).toBe(404);
    expect((await getJson("/api/orgs/missing/roster", owner.cookie)).status).toBe(404);

    const emptyOrg = await req("/api/orgs", outsiderCookie, { name: "Empty Org" });
    const emptyOrgId = ((await emptyOrg.json()) as { id: string }).id;
    const emptyRoster = await getJson(`/api/orgs/${emptyOrgId}/roster`, outsiderCookie);
    expect(emptyRoster.status).toBe(200);
    expect((await emptyRoster.json()).members).toEqual([]);
  });

  it("creates an org then a project, and the creator resolves as its admin via better-auth", async () => {
    const { cookie, orgId, projectId } = await onboard("owner@acme.test", "Owner", "Acme", "Widgets");
    await activateBilling(orgId);
    const me = await getJson("/api/me", cookie);
    const body = (await me.json()) as { memberships: { projectId: string; role: string }[] };
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].projectId).toBe(projectId);
    expect(body.memberships[0].role).toBe("admin");
    // the org/project pair is real: a better-auth organization exists at id == project id
    const org = await dbRef
      .prepare('SELECT id FROM "organization" WHERE id = ?')
      .get<{ id: string }>(projectId);
    expect(org?.id).toBe(projectId);
    expect(await dbRef.prepare(
      `SELECT domain, requested_generation FROM project_context_domains
        WHERE project_id=? AND domain IN ('architecture-tech','operational-external') ORDER BY domain`,
    ).all(projectId)).toEqual([
      { domain: "architecture-tech", requested_generation: 1 },
      { domain: "operational-external", requested_generation: 1 },
    ]);
  });

  it("returns duplicate-name flags and warnings while creating both same-name rows", async () => {
    const cookie = await signUpAndIn("dupes@acme.test", "Dupes");
    const orgResponses = await Promise.all([
      req("/api/orgs", cookie, { name: "Same Team" }),
      req("/api/orgs", cookie, { name: "Same Team" }),
    ]);
    const orgs = await Promise.all(orgResponses.map((response) => response.json())) as Array<{
      id: string; duplicateName: boolean; warning: string | null;
    }>;
    expect(orgs.map((org) => org.id).sort()).toEqual(["same-team", "same-team-2"]);
    expect(orgs.some((org) => org.duplicateName)).toBe(true);
    expect(orgs.every((org) => org.warning === (org.duplicateName
      ? "Another Org already uses this name. The new Org was still created."
      : null))).toBe(true);

    // Second project requires active billing (no free multi-project tier).
    await activateBilling("same-team");

    const projects = await Promise.all([
      req("/api/orgs/same-team/projects", cookie, { name: "Same Project" }),
      req("/api/orgs/same-team/projects", cookie, { name: "Same Project" }),
    ]);
    expect(projects.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(projects.map((response) => response.json())) as Array<{
      id: string; duplicateName: boolean; warning: string | null;
    }>;
    expect(bodies.map((body) => body.id).sort()).toEqual(["same-project", "same-project-2"]);
    expect(bodies.some((body) => body.duplicateName)).toBe(true);
    expect(bodies.every((body) => body.warning === (body.duplicateName
      ? "Another Project already uses this name. The new Project was still created."
      : null))).toBe(true);
  });

  it("rolls back the project half when the paired better-auth slug is already claimed", async () => {
    const cookie = await signUpAndIn("rollback@acme.test", "Rollback");
    const org = await req("/api/orgs", cookie, { name: "Owner Team" });
    const orgId = ((await org.json()) as { id: string }).id;
    const now = new Date().toISOString();
    await dbRef
      .prepare('INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)')
      .run("widgets", "Existing auth org", "widgets", now);

    const created = await req(`/api/orgs/${orgId}/projects`, cookie, { name: "Widgets" });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ id: "widgets-2", duplicateName: false });
    expect(await dbRef.prepare("SELECT id FROM projects WHERE id = ?").get("widgets")).toBeUndefined();
    expect(await dbRef.prepare("SELECT id FROM projects WHERE id = ?").get("widgets-2")).toBeDefined();
  });

  it("does not retry an unrelated better-auth organization uniqueness conflict", async () => {
    const cookie = await signUpAndIn("unique@acme.test", "Unique");
    const org = await req("/api/orgs", cookie, { name: "Owner Team" });
    const orgId = ((await org.json()) as { id: string }).id;
    const now = new Date().toISOString();
    await dbRef.exec('CREATE UNIQUE INDEX organization_name_test_unique ON "organization" (name)');
    await dbRef
      .prepare('INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)')
      .run("unrelated", "Reserved", "unrelated", now);

    const response = await req(`/api/orgs/${orgId}/projects`, cookie, { name: "Reserved" });
    expect(response.status).toBe(500);
    expect(await dbRef.prepare("SELECT id FROM projects WHERE name = ?").get("Reserved")).toBeUndefined();
  });
});

/** Follow the invitation's email magic link, then attach its session to the project. */
async function acceptInvite(inviteUrl: string): Promise<Response> {
  const token = new URL(inviteUrl).searchParams.get("token")!;
  const invitation = await dbRef.prepare('SELECT email FROM "invitation" WHERE token = ?').get<{ email: string }>(token);
  if (!invitation) throw new Error("missing invitation row");
  const cookie = await magicLinkSessionCookie(dbRef, invitation.email, invitation.email.split("@")[0]);
  const response = await req(`/api/invite/${token}/accept`, cookie, {}, "POST");
  const body = await response.text();
  const headers = new Headers(response.headers);
  headers.set("set-cookie", cookie);
  return new Response(body, { status: response.status, headers });
}

/** The session cookie an accept response sets (the invitee lands signed in). */
function cookieFrom(res: Response): string {
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  return setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

describe("#78 team management — invite by copyable join link, enforced through better-auth membership", () => {
  it("an admin invites by link; the teammate appears on the team ONLY after accepting", async () => {
    const { cookie, orgId, projectId } = await onboard("boss@acme.test", "Boss", "Acme", "Widgets");
    await activateBilling(orgId);
    const invite = await req(`/api/p/${projectId}/invite`, cookie, {
      email: "coder@acme.test",
      role: "coder",
    });
    expect(invite.status).toBe(200);
    const { inviteUrl } = (await invite.json()) as { inviteUrl: string };
    expect(inviteUrl).toContain("/join?token=");
    // no membership yet — nobody is provisioned by the invite itself
    let team = await getJson(`/api/p/${projectId}/team`, cookie);
    let members = (await team.json()).members as { email: string | null }[];
    expect(members.find((m) => m.email === "coder@acme.test")).toBeUndefined();
    // accept the link → the teammate joins at the invited role
    expect((await acceptInvite(inviteUrl)).status).toBe(200);
    team = await getJson(`/api/p/${projectId}/team`, cookie);
    members = (await team.json()).members as { role: string; email: string | null }[];
    expect(members.find((m) => m.email === "coder@acme.test")).toMatchObject({ role: "coder" });
    expect(await dbRef.prepare(
      `SELECT domain, requested_generation FROM project_context_domains
        WHERE project_id=? AND domain IN ('team-people','roles-collaboration') ORDER BY domain`,
    ).all(projectId)).toEqual([
      { domain: "roles-collaboration", requested_generation: 1 },
      { domain: "team-people", requested_generation: 1 },
    ]);
  });

  it("a non-admin member cannot invite or change roles (403)", async () => {
    const { cookie: adminCookie, orgId, projectId } = await onboard("adm@acme.test", "Adm", "Acme", "Widgets");
    await activateBilling(orgId);
    // the admin mints a link for the teammate, who accepts it and gains a
    // human membership + session
    const inv = (await (
      await req(`/api/p/${projectId}/invite`, adminCookie, { email: "human@acme.test", role: "human" })
    ).json()) as { inviteUrl: string };
    const humanCookie = cookieFrom(await acceptInvite(inv.inviteUrl));
    // …now the non-admin tries to invite and is refused (admin only)
    const badInvite = await req(`/api/p/${projectId}/invite`, humanCookie, {
      email: "x@acme.test",
      role: "coder",
    });
    expect(badInvite.status).toBe(403);
  });

  it("an admin changes a member's role and it takes effect on the next resolve", async () => {
    const { cookie, orgId, projectId } = await onboard("chief@acme.test", "Chief", "Acme", "Widgets");
    await activateBilling(orgId);
    await onboard("foreign@acme.test", "Foreign Person", "Other Team", "Other Project");
    const inv = (await (
      await req(`/api/p/${projectId}/invite`, cookie, { email: "promote@acme.test", role: "human" })
    ).json()) as { inviteUrl: string };
    await acceptInvite(inv.inviteUrl);
    const userId = (await dbRef
      .prepare('SELECT id FROM "user" WHERE email = ?')
      .get<{ id: string }>("promote@acme.test"))!.id;
    const change = await req(`/api/p/${projectId}/members/${userId}/role`, cookie, { role: "admin" });
    expect(change.status).toBe(200);
    const role = (await dbRef
      .prepare('SELECT role FROM "member" WHERE "userId" = ? AND "organizationId" = ?')
      .get<{ role: string }>(userId, projectId))!.role;
    expect(role).toBe("admin");
    const generations = () => dbRef.prepare(
      `SELECT domain, requested_generation FROM project_context_domains
        WHERE project_id=? AND domain IN ('team-people','roles-collaboration') ORDER BY domain`,
    ).all(projectId);
    expect(await generations()).toEqual([
      { domain: "roles-collaboration", requested_generation: 2 },
      { domain: "team-people", requested_generation: 2 },
    ]);
    expect((await req(`/api/p/${projectId}/members/${userId}/role`, cookie, { role: "admin" })).status).toBe(200);
    expect(await generations()).toEqual([
      { domain: "roles-collaboration", requested_generation: 2 },
      { domain: "team-people", requested_generation: 2 },
    ]);
    expect((await req(`/api/p/${projectId}/members/${userId}`, cookie, undefined, "DELETE")).status).toBe(200);
    expect(await generations()).toEqual([
      { domain: "roles-collaboration", requested_generation: 3 },
      { domain: "team-people", requested_generation: 3 },
    ]);
    expect((await req(`/api/p/${projectId}/members/${userId}`, cookie, undefined, "DELETE")).status).toBe(200);
    expect(await generations()).toEqual([
      { domain: "roles-collaboration", requested_generation: 3 },
      { domain: "team-people", requested_generation: 3 },
    ]);
  });
});

describe("roles are recorded, never exposed: creators are admins (admin implies human), invitees are humans", () => {
  it("creating a team records its creator; creating a project records the creator as admin", async () => {
    const { cookie: ownerCookie, orgId, projectId } = await onboard("maker@acme.test", "Maker", "Acme", "Widgets");
    await activateBilling(orgId);
    const userId = (await dbRef
      .prepare('SELECT id FROM "user" WHERE email = ?')
      .get<{ id: string }>("maker@acme.test"))!.id;
    // Team creator is recorded on the org row itself — there is no org-level
    // membership table, so created_by is the durable "who owns this team" fact.
    const org = await dbRef
      .prepare("SELECT created_by FROM orgs WHERE id = ?")
      .get<{ created_by: string | null }>(orgId);
    expect(org?.created_by).toBe(userId);
    const project = await dbRef
      .prepare("SELECT created_by FROM projects WHERE id = ?")
      .get<{ created_by: string | null }>(projectId);
    expect(project?.created_by).toBe(userId);
    // Project creator's member row carries "admin" — the stacked truth. Roles
    // stack (a person is human + admin), and every role check in the codebase
    // treats admin as implying human (tools.ts/server.ts: role === "human" ||
    // role === "admin"), so a single member row of admin preserves both.
    const row = await dbRef
      .prepare('SELECT role FROM "member" WHERE "userId" = ? AND "organizationId" = ?')
      .get<{ role: string }>(userId, projectId);
    expect(row?.role).toBe("admin");
    await dbRef.prepare('UPDATE "member" SET role = ? WHERE "userId" = ? AND "organizationId" = ?').run("human", userId, projectId);
    expect((await req(`/api/p/${projectId}/invite`, ownerCookie, { email: "creator-authorized@acme.test" })).status).toBe(200);
  });

  it("repairs every historical non-creator admin and admin invitation once", async () => {
    const owner = await onboard("repair-owner@acme.test", "Repair Owner", "Repair Org", "Repair Project");
    await activateBilling(owner.orgId);
    const explicitInvite = await req(`/api/p/${owner.projectId}/invite`, owner.cookie, {
      email: "explicit-admin@acme.test", role: "admin",
    });
    const explicitCookie = cookieFrom(await acceptInvite(((await explicitInvite.json()) as { inviteUrl: string }).inviteUrl));
    const accidentalInvite = await req(`/api/p/${owner.projectId}/invite`, owner.cookie, {
      email: "accidental-admin@acme.test", role: "human",
    });
    const accidentalCookie = cookieFrom(await acceptInvite(((await accidentalInvite.json()) as { inviteUrl: string }).inviteUrl));
    const accidentalId = (await dbRef.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>("accidental-admin@acme.test"))!.id;
    await req(`/api/p/${owner.projectId}/invite`, owner.cookie, {
      email: "pending-admin@acme.test", role: "admin",
    });

    await dbRef.prepare('UPDATE "member" SET role = ? WHERE "organizationId" = ? AND "userId" = ?').run("admin", owner.projectId, accidentalId);
    await dbRef.prepare("UPDATE projects SET created_by = NULL WHERE id = ?").run(owner.projectId);
    await dbRef.prepare("DELETE FROM memracer_auth_migrations").run();
    await repairLegacyProjectAdminRoles(dbRef);

    const roles = await dbRef.prepare(
      `SELECT u.email, m.role FROM "member" m JOIN "user" u ON u.id = m."userId"
        WHERE m."organizationId" = ? ORDER BY u.email`,
    ).all<{ email: string; role: string }>(owner.projectId);
    expect(roles).toEqual([
      { email: "accidental-admin@acme.test", role: "human" },
      { email: "explicit-admin@acme.test", role: "human" },
      { email: "repair-owner@acme.test", role: "admin" },
    ]);
    expect(await dbRef.prepare('SELECT email, role, status FROM "invitation" WHERE "organizationId" = ? ORDER BY email').all(owner.projectId)).toEqual([
      { email: "accidental-admin@acme.test", role: "human", status: "accepted" },
      { email: "explicit-admin@acme.test", role: "human", status: "accepted" },
      { email: "pending-admin@acme.test", role: "human", status: "pending" },
    ]);
    expect((await req(`/api/p/${owner.projectId}`, accidentalCookie, { name: "Repair Project" }, "DELETE")).status).toBe(403);
    expect((await req(`/api/p/${owner.projectId}/invite`, explicitCookie, { email: "denied@acme.test" })).status).toBe(403);

    expect((await req(`/api/p/${owner.projectId}/members/${accidentalId}/role`, owner.cookie, { role: "admin" })).status).toBe(200);
    await repairLegacyProjectAdminRoles(dbRef);
    expect(await dbRef.prepare('SELECT role FROM "member" WHERE "organizationId" = ? AND "userId" = ?').get(owner.projectId, accidentalId)).toEqual({ role: "admin" });
  });

  it("backfills missing Org and Project creators from the earliest historical admin", async () => {
    const owner = await onboard("unknown-owner@acme.test", "Unknown Owner", "Unknown Org", "Unknown Project");
    await activateBilling(owner.orgId);
    const invite = await req(`/api/p/${owner.projectId}/invite`, owner.cookie, {
      email: "later-admin@acme.test", role: "admin",
    });
    await acceptInvite(((await invite.json()) as { inviteUrl: string }).inviteUrl);
    const ownerId = (await dbRef.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>("unknown-owner@acme.test"))!.id;
    const laterId = (await dbRef.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>("later-admin@acme.test"))!.id;
    await dbRef.prepare('UPDATE "member" SET "createdAt" = ? WHERE "organizationId" = ? AND "userId" = ?').run("2026-01-01T00:00:00.000Z", owner.projectId, ownerId);
    await dbRef.prepare('UPDATE "member" SET "createdAt" = ? WHERE "organizationId" = ? AND "userId" = ?').run("2026-01-02T00:00:00.000Z", owner.projectId, laterId);
    await dbRef.prepare("UPDATE orgs SET created_by = NULL WHERE id = ?").run(owner.orgId);
    await dbRef.prepare("UPDATE projects SET created_by = NULL WHERE id = ?").run(owner.projectId);
    await dbRef.prepare("DELETE FROM memracer_auth_migrations").run();
    await dbRef.prepare("INSERT INTO memracer_auth_migrations (id, applied_at) VALUES (?, ?)").run("2026-07-16-admin-role-repair-v2", Date.now());

    await repairLegacyProjectAdminRoles(dbRef);

    expect(await dbRef.prepare("SELECT created_by FROM orgs WHERE id = ?").get(owner.orgId)).toEqual({ created_by: ownerId });
    expect(await dbRef.prepare("SELECT created_by FROM projects WHERE id = ?").get(owner.projectId)).toEqual({ created_by: ownerId });
    const repairedRoles = await dbRef.prepare('SELECT "userId", role FROM "member" WHERE "organizationId" = ?').all(owner.projectId);
    expect(repairedRoles).toHaveLength(2);
    expect(repairedRoles).toEqual(expect.arrayContaining(
      [
        { userId: ownerId, role: "admin" },
        { userId: laterId, role: "human" },
      ],
    ));
  });

  it("warns and leaves an unattributed Project unchanged without historical admins", async () => {
    const owner = await onboard("no-admin@acme.test", "No Admin", "No Admin Org", "No Admin Project");
    await activateBilling(owner.orgId);
    await dbRef.prepare("UPDATE orgs SET created_by = NULL WHERE id = ?").run(owner.orgId);
    await dbRef.prepare("UPDATE projects SET created_by = NULL WHERE id = ?").run(owner.projectId);
    await dbRef.prepare('UPDATE "member" SET role = ? WHERE "organizationId" = ?').run("human", owner.projectId);
    await dbRef.prepare("DELETE FROM memracer_auth_migrations").run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await repairLegacyProjectAdminRoles(dbRef);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(owner.projectId));
    expect(await dbRef.prepare("SELECT created_by FROM projects WHERE id = ?").get(owner.projectId)).toEqual({ created_by: null });
    expect(await dbRef.prepare('SELECT role FROM "member" WHERE "organizationId" = ?').get(owner.projectId)).toEqual({ role: "human" });
    warn.mockRestore();
  });

  it("an invite without a role records the member as human once the link is accepted — the only kind of invited person", async () => {
    const { cookie, orgId, projectId } = await onboard("own@acme.test", "Own", "Acme", "Widgets");
    await activateBilling(orgId);
    const invite = await req(`/api/p/${projectId}/invite`, cookie, { email: "teammate@acme.test" });
    expect(invite.status).toBe(200);
    const { inviteUrl } = (await invite.json()) as { inviteUrl: string };
    // Nobody is provisioned by the invite itself — the teammate joins on accept.
    await acceptInvite(inviteUrl);
    const role = (await dbRef
      .prepare(
        'SELECT m.role FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ? AND m."organizationId" = ?',
      )
      .get<{ role: string }>("teammate@acme.test", projectId))!.role;
    expect(role).toBe("human"); // invited ≠ admin; admin comes from creating
  });

  it("a present-but-invalid role is still rejected (400)", async () => {
    const { cookie, orgId, projectId } = await onboard("inv@acme.test", "Inv", "Acme", "Widgets");
    await activateBilling(orgId);
    const bad = await req(`/api/p/${projectId}/invite`, cookie, { email: "x@acme.test", role: "root" });
    expect(bad.status).toBe(400);
  });

  it("/api/me memberships carry the team (orgId/orgName) so the switcher can group by team", async () => {
    const { cookie, orgId, projectId } = await onboard("grp@acme.test", "Grp", "Acme Team", "Widgets");
    await activateBilling(orgId);
    const me = await getJson("/api/me", cookie);
    const body = (await me.json()) as {
      memberships: { projectId: string; orgId: string | null; orgName: string | null }[];
    };
    const m = body.memberships.find((x) => x.projectId === projectId)!;
    expect(m.orgId).toBe(orgId);
    expect(m.orgName).toBe("Acme Team");
  });
});

describe("#78 API keys — a member mints a headless key from the UI, no seeded token needed", () => {
  it("mints a key that resolves back to the caller's memberships", async () => {
    const { cookie, orgId, projectId } = await onboard("hk@acme.test", "Headless", "Acme", "Widgets");
    await activateBilling(orgId);
    const res = await req(`/api/p/${projectId}/api-keys`, cookie, { name: "laptop" });
    expect(res.status).toBe(200);
    const { key } = (await res.json()) as { key: string };
    expect(typeof key).toBe("string");
    const member = await resolveMember(dbRef, `Bearer ${key}`);
    expect(member).not.toBeNull();
    expect(member!.memberships.map((m) => m.projectId)).toContain(projectId);
  });
});

describe("#90 legacy-token cutover complete — static tokens are gone, better-auth only", () => {
  const KEY = "MEMRACER_LEGACY_TOKENS";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("a legacy static token is rejected (even with the retired flag set) while a minted api key resolves", async () => {
    // The retired flag is inert and the members/memberships tables no longer
    // exist: a legacy-shaped bearer resolves to nothing, no matter the env.
    process.env[KEY] = "1";
    expect(await resolveMember(dbRef, "Bearer seed-tok")).toBeNull();
    expect(await resolveMember(dbRef, "Bearer mr_anything")).toBeNull();

    // the replacement works: a minted better-auth api key resolves
    const { cookie, orgId, projectId } = await onboard("cut@acme.test", "Cut", "Acme", "Widgets");
    await activateBilling(orgId);
    const res = await req(`/api/p/${projectId}/api-keys`, cookie, {});
    const { key } = (await res.json()) as { key: string };
    expect(await resolveMember(dbRef, `Bearer ${key}`)).not.toBeNull();
  });
});
