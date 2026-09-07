import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";

describe("resumable MCP HTTP sessions", () => {
  let db: Db;
  let httpServer: Server;
  let worker: MediatorWorker;
  let url: URL;
  let token: string;
  let otherToken: string;
  const replacementServers: Array<{ server: Server; worker: MediatorWorker }> = [];

  beforeEach(async () => {
    db = openDb(":memory:");
    await betterAuthReady(db);
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','recallnet/demo')").run();
    token = (await seedMember(db, { name: "Dana", projectId: "demo", role: "human" })).token;
    otherToken = (await seedMember(db, { name: "Lee", projectId: "demo", role: "human" })).token;
    const made = createApp(db, { driverFor: () => new FakeDriver(), workerOpts: { tickMs: 20 } });
    worker = made.worker;
    await new Promise<void>((resolve) => { httpServer = made.app.listen(0, resolve); });
    url = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
  });

  afterEach(async () => {
    worker.stop();
    for (const replacement of replacementServers.splice(0)) {
      replacement.worker.stop();
      await new Promise<void>((resolve) => replacement.server.close(() => resolve()));
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await db.close();
  });

  it("issues a durable session, rejects another key, and closes it through DELETE", async () => {
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: "session-test", version: "1.0.0" });
    await client.connect(transport);
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const sessionId = transport.sessionId!;
    expect(await db.prepare("SELECT closed_at FROM mcp_sessions WHERE id=?").get(sessionId)).toEqual({ closed_at: null });
    const events = await db.prepare(
      "SELECT event_id, message FROM mcp_events WHERE session_id=? ORDER BY sequence ASC",
    ).all<{ event_id: string; message: string }>(sessionId);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const resumed = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
        "Mcp-Session-Id": sessionId,
        "Mcp-Protocol-Version": "2025-11-25",
        "Last-Event-ID": events[0].event_id,
      },
    });
    expect(resumed.status).toBe(200);
    const replayReader = resumed.body!.getReader();
    const replay = await replayReader.read();
    expect(new TextDecoder().decode(replay.value)).toContain(`id: ${events[1].event_id}`);
    await replayReader.cancel();

    const replacement = createApp(db, { driverFor: () => new FakeDriver(), workerOpts: { tickMs: 20 } });
    const replacementServer = await new Promise<Server>((resolve) => {
      const listening = replacement.app.listen(0, () => resolve(listening));
    });
    replacementServers.push({ server: replacementServer, worker: replacement.worker });
    const replacementUrl = new URL(`http://127.0.0.1:${(replacementServer.address() as AddressInfo).port}/mcp`);
    const replaced = await fetch(replacementUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
        "Mcp-Session-Id": sessionId,
        "Mcp-Protocol-Version": "2025-11-25",
        "Last-Event-ID": events[0].event_id,
      },
    });
    expect(replaced.status).toBe(200);
    // Full rehydrate keeps the SSE open for live delivery — read one frame then cancel.
    const replacedReader = replaced.body!.getReader();
    const replacedFrame = await replacedReader.read();
    expect(new TextDecoder().decode(replacedFrame.value)).toContain(`id: ${events[1].event_id}`);
    await replacedReader.cancel();

    const crossed = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otherToken}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
        "Mcp-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    });
    expect(crossed.status).toBe(404);

    await transport.terminateSession();
    expect(await db.prepare("SELECT closed_at FROM mcp_sessions WHERE id=?").get<{ closed_at: number | null }>(sessionId)).toEqual({ closed_at: expect.any(Number) });
    await client.close();
  });

  it("rehydrates a durable session on a fresh process so tools/list works after redeploy", async () => {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "session-rehydrate", version: "1.0.0" });
    await client.connect(transport);
    const sessionId = transport.sessionId!;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // Simulate redeploy: new process, empty in-memory mcpSessions, same durable DB.
    const replacement = createApp(db, { driverFor: () => new FakeDriver(), workerOpts: { tickMs: 20 } });
    const replacementServer = await new Promise<Server>((resolve) => {
      const listening = replacement.app.listen(0, () => resolve(listening));
    });
    replacementServers.push({ server: replacementServer, worker: replacement.worker });
    const replacementUrl = new URL(
      `http://127.0.0.1:${(replacementServer.address() as AddressInfo).port}/mcp`,
    );

    const tools = await fetch(replacementUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
        "Mcp-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(tools.status).toBe(200);
    const toolsBody = await tools.text();
    expect(toolsBody).toMatch(/tools|human_status|human_submit/);

    const wrongKey = await fetch(replacementUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otherToken}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
        "Mcp-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(wrongKey.status).toBe(404);

    await transport.terminateSession();
    const afterClose = await fetch(replacementUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
        "Mcp-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(afterClose.status).toBe(404);

    await client.close();
  });
});
