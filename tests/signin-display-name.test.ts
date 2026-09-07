// Display name is not collected on every magic-link sign-in; Settings edits it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type Db } from "../src/db.js";
import { authReady } from "../src/auth/instance.js";
import { createApp } from "../src/server.js";
import { latestMagicLink, magicLinkSessionCookie } from "./helpers/auth.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";

const SIGNIN = readFileSync(
  path.join(process.cwd(), "src/dashboard/public/signin.html"),
  "utf8",
);

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let db: Db;

beforeEach(async () => {
  db = openDb(":memory:");
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("p", "P", "recallnet/p");
  const made = createApp(db, { driverFor: () => new FakeDriver(), workerOpts: { tickMs: 20, jobTimeoutMs: 2000 } });
  worker = made.worker;
  await authReady(db);
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("sign-in display name (#544)", () => {
  it("signin.html has no display-name field and posts email only", () => {
    expect(SIGNIN).not.toMatch(/id="name"/);
    expect(SIGNIN).not.toMatch(/for="name"/);
    expect(SIGNIN).not.toMatch(/placeholder="display name/);
    expect(SIGNIN).toMatch(/type="email"/);
    // Body must not include name: — only email + callback URLs
    expect(SIGNIN).toMatch(/JSON\.stringify\(\{\s*email,\s*callbackURL/);
    expect(SIGNIN).not.toMatch(/\.\.\.\(name/);
  });

  it("new users default name from email local-part when name is omitted", async () => {
    // Seed membership path: invite-only off — create via magic link helper without custom name
    const email = "newbie@example.test";
    // magicLinkSessionCookie with no name → auth create hook fills local-part
    await magicLinkSessionCookie(db, email);
    const row = await db
      .prepare('SELECT name, email FROM "user" WHERE email = ?')
      .get<{ name: string; email: string }>(email);
    expect(row?.email).toBe(email);
    expect(row?.name).toBe("newbie");
  });

  it("re-signin without name leaves user.name unchanged", async () => {
    const email = "returner@example.test";
    await magicLinkSessionCookie(db, email, "Original Name");
    await db.prepare('UPDATE "user" SET name = ? WHERE email = ?').run("Original Name", email);

    // Second magic-link request without name (as signin.html does)
    const res = await fetch(`${baseUrl}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        callbackURL: `${baseUrl}/dashboard`,
        newUserCallbackURL: `${baseUrl}/dashboard`,
      }),
    });
    expect(res.ok).toBe(true);
    // Even if client tried to send a name, hooks strip it — prove overwrite fails
    const res2 = await fetch(`${baseUrl}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Hijacked",
        callbackURL: `${baseUrl}/dashboard`,
        newUserCallbackURL: `${baseUrl}/dashboard`,
      }),
    });
    expect(res2.ok).toBe(true);
    // Consume one link so the flow works; name must stay Original Name
    const link = latestMagicLink(email);
    const token = new URL(link).searchParams.get("token");
    expect(token).toBeTruthy();
    await fetch(
      `${baseUrl}/api/auth/magic-link/verify?token=${encodeURIComponent(token!)}&callbackURL=${encodeURIComponent(`${baseUrl}/dashboard`)}`,
      { redirect: "manual" },
    );
    const row = await db
      .prepare('SELECT name FROM "user" WHERE email = ?')
      .get<{ name: string }>(email);
    expect(row?.name).toBe("Original Name");
  });

  it("settings update-user renames the signed-in user", async () => {
    const cookie = await magicLinkSessionCookie(db, "editor@example.test", "Before");
    const res = await fetch(`${baseUrl}/api/auth/update-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "After Edit" }),
    });
    expect(res.ok).toBe(true);
    const row = await db
      .prepare('SELECT name FROM "user" WHERE email = ?')
      .get<{ name: string }>("editor@example.test");
    expect(row?.name).toBe("After Edit");
  });
});
