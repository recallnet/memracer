// The CLI's hosted bootstrap: an UNAUTHENTICATED GET /install.sh that pipes
// into `sh` to install the npm package. Served before the /mcp auth guard.
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
let dbRef: Db;

beforeEach(async () => {
  dbRef = openDb(":memory:");
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
});

describe("GET /install.sh", () => {
  it("serves an unauthenticated shell installer for the CLI", async () => {
    const res = await fetch(`${baseUrl}/install.sh`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-shellscript");
    const body = await res.text();
    expect(body.startsWith("#!/bin/sh")).toBe(true);
    // Default channel is the pre-release GitHub tarball.
    expect(body).toContain("gh release download cli-latest -R recallnet/memracer");
  });
});
