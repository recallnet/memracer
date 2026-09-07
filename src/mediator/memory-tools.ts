import type { Db } from "../db.js";
import type { MemoryToolExecutor, ToolDefinition } from "./driver.js";
import { MemoryStore, type MemoryDoc } from "./memory.js";

/** Chars of body context returned around a grep hit. */
const SNIPPET_RADIUS = 100;

function snippet(body: string, needle: string): string {
  const i = body.toLowerCase().indexOf(needle.toLowerCase());
  if (i === -1) return body.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, i - SNIPPET_RADIUS);
  const end = Math.min(body.length, i + needle.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${body.slice(start, end).trim()}${end < body.length ? "…" : ""}`;
}

/**
 * OKF memory + thread tools hard-bound to ONE project. No method accepts a
 * project argument, so cross-tenant reach is structurally impossible — not a
 * runtime check that could be bypassed. thread_read and plan_read additionally
 * refuse rows outside the bound project (the dashboard's cross-project 404
 * boundary). Every failure returns {error} instead of throwing, so a
 * model tool-call can never crash the driver loop.
 */
export class ScopedMemoryTools implements MemoryToolExecutor {
  private readonly readPlanIds = new Set<number>();
  private readonly writtenPaths = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly memory: MemoryStore,
    private readonly projectId: string,
    private readonly taskId?: number,
  ) {}

  private async recordWrite(action: "Wrote" | "Updated", path: string): Promise<void> {
    await this.memory.appendLog(this.projectId, `${action} knowledge: ${path}`, this.taskId);
  }

  private async okfGrep(query: string): Promise<unknown> {
    const q = String(query ?? "").trim();
    if (!q) return { error: "okf_grep requires a non-empty query" };
    const rows = await this.db
      .prepare("SELECT path, title, description, tags, body FROM memory_docs WHERE project_id=? ORDER BY path")
      .all<{ path: string; title: string; description: string; tags: string; body: string }>(this.projectId);
    const needle = q.toLowerCase();
    const matches = rows
      .filter((r) => `${r.path}\n${r.title}\n${r.description}\n${r.tags}\n${r.body}`.toLowerCase().includes(needle))
      .map((r) => ({ path: r.path, title: r.title, snippet: snippet(r.body || r.description, q) }));
    return { matches };
  }

  private async okfRead(path?: string): Promise<unknown> {
    if (!path || path === "index.md") {
      return { path: "index.md", content: await this.memory.renderIndex(this.projectId) };
    }
    const indexPath = path.endsWith("/") ? `${path}index.md` : path;
    if (indexPath.endsWith("/index.md")) {
      const index = (await this.memory.renderIndexes(this.projectId)).get(indexPath);
      return index ? { path: indexPath, content: index } : { error: `not found: ${path}` };
    }
    const doc = await this.memory.get(this.projectId, path);
    if (!doc) return { error: `not found: ${path}` };
    return { path, revision: doc.updated_at, content: this.memory.renderConcept(doc) };
  }

  private provenance(args: Record<string, unknown>, existing?: MemoryDoc["provenance"]): MemoryDoc["provenance"] {
    return {
      ...existing,
      ...(this.taskId === undefined ? {} : { sourceTask: this.taskId }),
      asOf: new Date().toISOString(),
      ...(Array.isArray(args.supersedes) ? { supersedes: args.supersedes.map(String) } : {}),
      ...(Array.isArray(args.superseded_by) ? { supersededBy: args.superseded_by.map(String) } : {}),
    };
  }

  private async okfWrite(args: Record<string, unknown>): Promise<unknown> {
    try {
      const path = String(args.path ?? "");
      await this.db.transaction(async () => {
        await this.memory.create(this.projectId, {
          path,
          type: String(args.type ?? ""),
          title: String(args.title ?? ""),
          description: String(args.description ?? ""),
          tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
          body: String(args.body ?? ""),
          provenance: this.provenance(args),
        });
        await this.recordWrite("Wrote", path);
      });
      this.writtenPaths.add(path);
      return { ok: true, path: args.path, bundle: await this.memory.validateBundle(this.projectId) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async okfUpdate(args: Record<string, unknown>): Promise<unknown> {
    const path = String(args.path ?? "");
    const existing = await this.memory.get(this.projectId, path);
    if (!existing) return { error: `not found: ${path}` };
    const merged: Omit<MemoryDoc, "updated_at"> = {
      path,
      type: args.type !== undefined ? String(args.type) : existing.type,
      title: args.title !== undefined ? String(args.title) : existing.title,
      description: args.description !== undefined ? String(args.description) : existing.description,
      tags: Array.isArray(args.tags) ? args.tags.map(String) : existing.tags,
      body: args.body !== undefined ? String(args.body) : existing.body,
      provenance: this.provenance(args, existing.provenance),
    };
    try {
      await this.db.transaction(async () => {
        await this.memory.update(this.projectId, merged, existing.updated_at);
        await this.recordWrite("Updated", path);
      });
      this.writtenPaths.add(path);
      return { ok: true, path, bundle: await this.memory.validateBundle(this.projectId) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async okfValidate(): Promise<unknown> {
    return this.memory.validateBundle(this.projectId);
  }

  private async threadGrep(query: string): Promise<unknown> {
    const q = String(query ?? "").trim();
    if (!q) return { error: "thread_grep requires a non-empty query" };
    const rows = await this.db
      .prepare(
        `SELECT th.id AS thread_id, th.kind, m.content
         FROM threads th JOIN thread_messages m ON m.thread_id = th.id
         WHERE th.project_id = ? ORDER BY th.id, m.id`,
      )
      .all<{ thread_id: number; kind: string; content: string }>(this.projectId);
    const needle = q.toLowerCase();
    const seen = new Set<number>();
    const matches: { thread_id: number; kind: string; snippet: string }[] = [];
    for (const r of rows) {
      if (seen.has(r.thread_id) || !r.content.toLowerCase().includes(needle)) continue;
      seen.add(r.thread_id);
      matches.push({ thread_id: r.thread_id, kind: r.kind, snippet: snippet(r.content, q) });
    }
    return { matches };
  }

  private async threadRead(threadId: unknown): Promise<unknown> {
    const id = Number(threadId);
    if (!Number.isInteger(id)) return { error: "thread_read requires a numeric threadId" };
    // The security boundary: a thread not in the bound project is not found,
    // exactly as a cross-project dashboard fetch 404s.
    const thread = await this.db
      .prepare("SELECT id, kind FROM threads WHERE id=? AND project_id=?")
      .get<{ id: number; kind: string }>(id, this.projectId);
    if (!thread) return { error: `not found: thread ${id}` };
    const messages = await this.db
      .prepare("SELECT role, author, content FROM thread_messages WHERE thread_id=? ORDER BY id")
      .all<{ role: string; author: string; content: string }>(id);
    return { thread_id: id, kind: thread.kind, messages };
  }

  private async planGrep(query: string): Promise<unknown> {
    const q = String(query ?? "").trim();
    if (!q) return { error: "plan_grep requires a non-empty query" };
    const rows = await this.db
      .prepare(
        `SELECT id, title, state, plan FROM tasks
         WHERE project_id=? AND plan IS NOT NULL AND trim(plan) != ''
         ORDER BY id`,
      )
      .all<{ id: number; title: string; state: string; plan: string }>(this.projectId);
    const needle = q.toLowerCase();
    const matches = rows
      .filter((row) => row.plan.toLowerCase().includes(needle))
      .map((row) => ({ task_id: row.id, title: row.title, state: row.state, snippet: snippet(row.plan, q) }));
    return { matches };
  }

  private async planRead(taskId: unknown): Promise<unknown> {
    const id = Number(taskId);
    if (!Number.isInteger(id)) return { error: "plan_read requires a numeric taskId" };
    const task = await this.db
      .prepare(
        `SELECT id, title, state, plan FROM tasks
         WHERE id=? AND project_id=? AND plan IS NOT NULL AND trim(plan) != ''`,
      )
      .get<{ id: number; title: string; state: string; plan: string }>(id, this.projectId);
    if (!task) return { error: `not found: plan for task ${id}` };
    this.readPlanIds.add(id);
    return { task_id: task.id, title: task.title, state: task.state, plan: task.plan };
  }

  citablePlanIds(): ReadonlySet<number> {
    return this.readPlanIds;
  }

  writtenMemoryPaths(): ReadonlySet<string> {
    return this.writtenPaths;
  }

  toolDefinitions(): ToolDefinition[] {
    const str = { type: "string" };
    return [
      {
        type: "function",
        function: {
          name: "okf_grep",
          description: "Search your project memory (OKF concepts) by substring; returns matching path + snippet.",
          parameters: { type: "object", properties: { query: str }, required: ["query"] },
        },
      },
      {
        type: "function",
        function: {
          name: "okf_validate",
          description: "Render and check the complete generated OKF bundle after multi-asset curation; reports index status and reciprocal-link gaps.",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "okf_read",
          description: "Read one OKF concept by path, or the generated index when path is omitted or 'index.md'.",
          parameters: { type: "object", properties: { path: str } },
        },
      },
      {
        type: "function",
        function: {
          name: "okf_write",
          description: "Create a new OKF concept with optional supersession provenance. Fails when the path already exists; read and use okf_update instead.",
          parameters: {
            type: "object",
            properties: {
              path: str,
              type: str,
              title: str,
              description: str,
              tags: { type: "array", items: { type: "string" } },
              body: str,
              supersedes: { type: "array", items: str },
              superseded_by: { type: "array", items: str },
            },
            required: ["path", "type", "title", "description", "tags", "body"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "okf_update",
          description: "Compare-and-swap update of an existing OKF concept. Omitted fields are preserved; a concurrent edit returns a reread-and-retry error.",
          parameters: { type: "object", properties: { path: str, type: str, title: str, description: str, tags: { type: "array", items: { type: "string" } }, body: str, supersedes: { type: "array", items: str }, superseded_by: { type: "array", items: str } }, required: ["path"] },
        },
      },
      {
        type: "function",
        function: {
          name: "thread_grep",
          description: "Search your project's conversation threads by substring; returns matching thread_id + snippet.",
          parameters: { type: "object", properties: { query: str }, required: ["query"] },
        },
      },
      {
        type: "function",
        function: {
          name: "thread_read",
          description: "Read a thread's full messages by its id (a concept may cite one). Only your project's threads are visible.",
          parameters: { type: "object", properties: { threadId: { type: "number" } }, required: ["threadId"] },
        },
      },
      {
        type: "function",
        function: {
          name: "plan_grep",
          description: "Search stored coder plans in your project by substring; returns matching task_id, title, state, and snippet.",
          parameters: { type: "object", properties: { query: str }, required: ["query"] },
        },
      },
      {
        type: "function",
        function: {
          name: "plan_read",
          description: "Read a task's stored coder plan by task id. Only your project's plans are visible.",
          parameters: { type: "object", properties: { taskId: { type: "number" } }, required: ["taskId"] },
        },
      },
    ];
  }

  async dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    const a = args ?? {};
    try {
      switch (name) {
        case "okf_grep":
          return await this.okfGrep(a.query as string);
        case "okf_read":
          return await this.okfRead(a.path as string | undefined);
        case "okf_write":
          return await this.okfWrite(a);
        case "okf_update":
          return await this.okfUpdate(a);
        case "okf_validate":
          return await this.okfValidate();
        case "thread_grep":
          return await this.threadGrep(a.query as string);
        case "thread_read":
          return await this.threadRead(a.threadId);
        case "plan_grep":
          return await this.planGrep(a.query as string);
        case "plan_read":
          return await this.planRead(a.taskId);
        default:
          return { error: `unknown tool: ${name}` };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Factory for project-scoped memory tools. The only way to obtain tools is
 * bind(projectId); there is no unscoped tool surface, so a caller cannot omit
 * or forge the tenant. Task attribution is supplied by the server context,
 * never by model tool arguments.
 */
export class MemoryTools {
  private readonly memory: MemoryStore;
  constructor(private readonly db: Db) {
    this.memory = new MemoryStore(db);
  }
  bind(projectId: string, taskId?: number): ScopedMemoryTools {
    return new ScopedMemoryTools(this.db, this.memory, projectId, taskId);
  }
}
