// Public marketing waitlist: store email, idempotent on duplicate, no auth.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let db: Db;

beforeEach(async () => {
  db = openDb(":memory:");
  const made = createApp(db, { driverFor: () => new FakeDriver() });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await db.close();
});

describe("POST /api/waitlist", () => {
  it("stores a normalized email without auth and is idempotent", async () => {
    const res = await fetch(`${baseUrl}/api/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "  Ada@Example.COM " }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const stored = await db
      .prepare("SELECT email, source FROM waitlist_emails WHERE email = ?")
      .get<{ email: string; source: string | null }>("ada@example.com");
    expect(stored).toEqual({ email: "ada@example.com", source: "homepage" });

    const again = await fetch(`${baseUrl}/api/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com" }),
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });

    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM waitlist_emails WHERE email = ?")
      .get<{ n: number }>("ada@example.com");
    expect(Number(count?.n)).toBe(1);
  });

  it("rejects missing or invalid email with 400", async () => {
    for (const body of [{}, { email: "" }, { email: "not-an-email" }, { email: "a@b" }]) {
      const res = await fetch(`${baseUrl}/api/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("creates waitlist_emails on openDb", async () => {
    const row = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='waitlist_emails'",
      )
      .get<{ name: string }>();
    expect(row?.name).toBe("waitlist_emails");
  });
});
