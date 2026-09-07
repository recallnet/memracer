import { beforeEach, describe, expect, it } from "vitest";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../src/db.js";
import { openDb } from "../src/db.js";
import {
  DbMcpEventStore,
  McpSessionStore,
  markTransportSessionInitialized,
  restoreClientCapabilities,
} from "../src/mcp-session.js";

describe("DB-backed MCP sessions and replay events", () => {
  let db: Db;

  beforeEach(() => { db = openDb(":memory:"); });

  it("binds sessions to one key and expires or closes them durably", async () => {
    const sessions = new McpSessionStore(db, 1_000);
    await sessions.create({ id: "s1", keyId: "key-a", memberName: "Dana", projectIds: ["p1"], capabilities: { elicitation: {} } });
    expect(await sessions.active("s1", "key-a")).toMatchObject({ id: "s1", key_id: "key-a" });
    expect(await sessions.active("s1", "key-b")).toBeNull();
    expect(await sessions.capableHumanSessions("p1", "Dana")).toHaveLength(1);
    expect(await sessions.close("s1", "key-a")).toBe(true);
    expect(await sessions.active("s1", "key-a")).toBeNull();
    await sessions.cleanup();
    expect(await db.prepare("SELECT id FROM mcp_sessions WHERE id='s1'").get()).toBeUndefined();
  });

  it("replays only later events from the checkpoint stream and rejects foreign checkpoints", async () => {
    const sessions = new McpSessionStore(db);
    await sessions.create({ id: "s1", keyId: "key-a", memberName: "Dana", projectIds: ["p1"] });
    await sessions.create({ id: "s2", keyId: "key-b", memberName: "Lee", projectIds: ["p1"] });
    const store = new DbMcpEventStore(db, "s1");
    const first = await store.storeEvent("stream-a", { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "p", progress: 1 } } as JSONRPCMessage);
    const second = await store.storeEvent("stream-a", { jsonrpc: "2.0", id: 1, result: { ok: true } } as JSONRPCMessage);
    await store.storeEvent("stream-b", { jsonrpc: "2.0", id: 2, result: { ignored: true } } as JSONRPCMessage);
    const sent: Array<{ id: string; message: JSONRPCMessage }> = [];
    expect(await store.replayEventsAfter(first, { send: async (id, message) => { sent.push({ id, message }); } })).toBe("stream-a");
    expect(sent).toEqual([{ id: second, message: { jsonrpc: "2.0", id: 1, result: { ok: true } } }]);
    await expect(new DbMcpEventStore(db, "s2").replayEventsAfter(first, { send: async () => undefined })).rejects.toThrow("checkpoint");
  });

  it("marks a transport initialized for a durable session id and restores capabilities", () => {
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });
    expect(transport.sessionId).toBeUndefined();
    markTransportSessionInitialized(transport, sessionId);
    expect(transport.sessionId).toBe(sessionId);
    const server = { _clientCapabilities: undefined as unknown };
    restoreClientCapabilities(server, JSON.stringify({ elicitation: { form: {} } }));
    expect(server._clientCapabilities).toEqual({ elicitation: { form: {} } });
    restoreClientCapabilities(server, "not-json");
    expect(server._clientCapabilities).toEqual({ elicitation: { form: {} } });
  });

  it("allocates unique ordered event IDs under concurrent writes", async () => {
    const sessions = new McpSessionStore(db);
    await sessions.create({ id: "s1", keyId: "key-a", memberName: "Dana", projectIds: ["p1"] });
    const store = new DbMcpEventStore(db, "s1");
    const ids = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.storeEvent("stream-a", {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "p", progress: index },
      } as JSONRPCMessage)));
    expect(new Set(ids).size).toBe(20);
    expect((await db.prepare("SELECT sequence FROM mcp_events WHERE session_id=? ORDER BY sequence").all<{ sequence: number }>("s1"))
      .map((row) => row.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });
});
