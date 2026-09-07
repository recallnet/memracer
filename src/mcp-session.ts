import type {
  EventStore,
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "./db.js";

export const MCP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface McpSessionRow {
  id: string;
  key_id: string;
  member_name: string;
  project_ids: string;
  capabilities: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  closed_at: number | null;
  next_event_sequence: number;
}

export class McpSessionStore {
  constructor(private readonly db: Db, private readonly ttlMs = MCP_SESSION_TTL_MS) {}

  async create(input: {
    id: string;
    keyId: string;
    memberName: string;
    projectIds: string[];
    capabilities?: unknown;
  }): Promise<void> {
    const now = Date.now();
    await this.db.prepare(
      `INSERT INTO mcp_sessions
       (id, key_id, member_name, project_ids, capabilities, created_at, last_seen_at, expires_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      input.id,
      input.keyId,
      input.memberName,
      JSON.stringify(input.projectIds),
      JSON.stringify(input.capabilities ?? {}),
      now,
      now,
      now + this.ttlMs,
    );
  }

  async setCapabilities(id: string, keyId: string, capabilities: unknown): Promise<void> {
    await this.db.prepare(
      `UPDATE mcp_sessions SET capabilities=?, last_seen_at=?
       WHERE id=? AND key_id=? AND closed_at IS NULL AND expires_at>?`,
    ).run(JSON.stringify(capabilities ?? {}), Date.now(), id, keyId, Date.now());
  }

  async active(id: string, keyId: string): Promise<McpSessionRow | null> {
    const row = await this.db.prepare(
      `SELECT id, key_id, member_name, project_ids, capabilities, created_at, last_seen_at, expires_at, closed_at, next_event_sequence
       FROM mcp_sessions WHERE id=? AND key_id=? AND closed_at IS NULL AND expires_at>?`,
    ).get<McpSessionRow>(id, keyId, Date.now());
    return row ?? null;
  }

  async touch(id: string, keyId: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.db.prepare(
      `UPDATE mcp_sessions SET last_seen_at=?, expires_at=?
       WHERE id=? AND key_id=? AND closed_at IS NULL AND expires_at>?`,
    ).run(now, now + this.ttlMs, id, keyId, now);
    return result.changes === 1;
  }

  async close(id: string, keyId: string): Promise<boolean> {
    const result = await this.db.prepare(
      "UPDATE mcp_sessions SET closed_at=? WHERE id=? AND key_id=? AND closed_at IS NULL",
    ).run(Date.now(), id, keyId);
    return result.changes === 1;
  }

  async capableHumanSessions(projectId: string, memberName: string): Promise<McpSessionRow[]> {
    const rows = await this.db.prepare(
      `SELECT id, key_id, member_name, project_ids, capabilities, created_at, last_seen_at, expires_at, closed_at, next_event_sequence
       FROM mcp_sessions WHERE member_name=? AND closed_at IS NULL AND expires_at>? ORDER BY last_seen_at DESC`,
    ).all<McpSessionRow>(memberName, Date.now());
    return rows.filter((row) => {
      try {
        const projects = JSON.parse(row.project_ids) as unknown;
        const capabilities = JSON.parse(row.capabilities) as { elicitation?: unknown };
        return Array.isArray(projects) && projects.includes(projectId) && capabilities.elicitation != null;
      } catch {
        return false;
      }
    });
  }

  async cleanup(now = Date.now()): Promise<void> {
    await this.db.prepare("DELETE FROM mcp_sessions WHERE closed_at IS NOT NULL OR expires_at<=?").run(now);
  }
}

export class DbMcpEventStore implements EventStore {
  constructor(private readonly db: Db, private readonly sessionId: string) {}

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    return this.db.transaction(async () => {
      const allocated = await this.db.prepare(
        `UPDATE mcp_sessions
         SET next_event_sequence=next_event_sequence+1
         WHERE id=?
         RETURNING next_event_sequence-1 AS sequence`,
      ).get<{ sequence: number }>(this.sessionId);
      if (!allocated) throw new Error("MCP session not found while storing event");
      const sequence = Number(allocated.sequence);
      const eventId = `${this.sessionId}:${sequence}`;
      await this.db.prepare(
        `INSERT INTO mcp_events (event_id, session_id, stream_id, sequence, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(eventId, this.sessionId, streamId, sequence, JSON.stringify(message), Date.now());
      return eventId;
    });
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    const row = await this.db.prepare(
      "SELECT stream_id FROM mcp_events WHERE event_id=? AND session_id=?",
    ).get<{ stream_id: string }>(eventId, this.sessionId);
    return row?.stream_id;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    const checkpoint = await this.db.prepare(
      "SELECT stream_id, sequence FROM mcp_events WHERE event_id=? AND session_id=?",
    ).get<{ stream_id: string; sequence: number }>(lastEventId, this.sessionId);
    if (!checkpoint) throw new Error("event checkpoint not found for session");
    const rows = await this.db.prepare(
      `SELECT event_id, message FROM mcp_events
       WHERE session_id=? AND stream_id=? AND sequence>? ORDER BY sequence ASC`,
    ).all<{ event_id: string; message: string }>(this.sessionId, checkpoint.stream_id, checkpoint.sequence);
    for (const row of rows) await send(row.event_id, JSON.parse(row.message) as JSONRPCMessage);
    return checkpoint.stream_id;
  }
}

/**
 * SDK StreamableHTTPServerTransport has no public rehydrate API. After a
 * process restart we rebuild a transport for a still-valid durable session id
 * and mark it initialized so non-initialize requests validate against that id.
 * Relies on the Node wrapper's `_webStandardTransport` field; isolate here so
 * an SDK rename fails in one place (covered by server-session-resume tests).
 */
export function markTransportSessionInitialized(
  transport: StreamableHTTPServerTransport,
  sessionId: string,
): void {
  const inner = (
    transport as unknown as {
      _webStandardTransport: { sessionId?: string; _initialized: boolean };
    }
  )._webStandardTransport;
  inner.sessionId = sessionId;
  inner._initialized = true;
}

/**
 * Restore client capabilities stored on the durable session row onto a fresh
 * McpServer Protocol instance so elicitation routing still works after rehydrate.
 */
export function restoreClientCapabilities(
  server: { _clientCapabilities?: unknown },
  capabilitiesJson: string,
): void {
  try {
    const parsed = JSON.parse(capabilitiesJson) as unknown;
    if (parsed && typeof parsed === "object") {
      server._clientCapabilities = parsed;
    }
  } catch {
    // Corrupt capability blobs should not block rehydrate; elicitation degrades.
  }
}
