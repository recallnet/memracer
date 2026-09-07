import type { Db } from "./db.js";
import { wipeProjectMemory } from "./mediator/okf-migration.js";
import { apiKeyProjectId } from "./auth.js";

/**
 * Permanently remove one project and every row owned by it in one transaction.
 * There is no soft-delete or 30-day archive: wipe is immediate and irreversible
 * at the application layer. External backups (database replication, object
 * store) may still retain historical copies for recovery.
 * The caller owns authorization and must publish change notifications only
 * after this transaction resolves.
 */
export async function deleteProject(db: Db, projectId: string): Promise<void> {
  await db.transaction(async () => {
    // tasks.root_thread_id and threads.task_id form a deliberate Postgres
    // cycle. Defer its FK, then sever both sides before deleting either set.
    if (db.dialect === "postgres") await db.exec("SET CONSTRAINTS tasks_root_thread_id_fkey DEFERRED");
    await db.prepare("UPDATE tasks SET root_thread_id = NULL WHERE root_thread_id IN (SELECT id FROM threads WHERE project_id = ?)").run(projectId);
    await db.prepare("UPDATE tasks SET parent_id = NULL WHERE parent_id IN (SELECT id FROM tasks WHERE project_id = ?)").run(projectId);
    await db.prepare("UPDATE threads SET task_id = NULL WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").run(projectId);
    await db.prepare("UPDATE threads SET root_id = NULL WHERE root_id IN (SELECT id FROM threads WHERE project_id = ?)").run(projectId);

    // Conversation joins point into threads, tasks, and decisions. Clear them
    // before any of those parents; all selectors remain project-scoped through
    // the owning conversation.
    const doomedConversations =
      "SELECT id FROM conversations WHERE project_id = ? OR thread_id IN (SELECT id FROM threads WHERE project_id = ?)";
    await db.prepare(
      `DELETE FROM conversation_participants WHERE conversation_id IN (${doomedConversations})`,
    ).run(projectId, projectId);
    await db.prepare(
      `DELETE FROM conversation_tasks WHERE conversation_id IN (${doomedConversations}) OR task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
    ).run(projectId, projectId, projectId);
    await db.prepare(
      `DELETE FROM conversation_decisions WHERE conversation_id IN (${doomedConversations}) OR decision_id IN (SELECT id FROM decision_log WHERE project_id = ?)`,
    ).run(projectId, projectId, projectId);
    await db.prepare(`DELETE FROM conversations WHERE id IN (${doomedConversations})`).run(projectId, projectId);

    // Event parent links are self-referential, so delete the project's stream
    // as a set after clearing nullable edges. No project may own an edge into a
    // different project's stream, but clearing first also makes corrupt legacy
    // recordings deletable without weakening FK enforcement.
    const doomedEvents =
      "SELECT id FROM session_events WHERE project_id = ? OR session_id IN (SELECT id FROM threads WHERE project_id = ?)";
    await db.prepare(`UPDATE session_events SET parent_id = NULL WHERE parent_id IN (${doomedEvents})`).run(projectId, projectId);
    await db.prepare("UPDATE session_events SET thread_id = NULL WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ?)").run(projectId);
    await db.prepare("UPDATE session_events SET task_id = NULL WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").run(projectId);
    await db.prepare(`DELETE FROM session_events WHERE id IN (${doomedEvents})`).run(projectId, projectId);
    await db.prepare(
      "DELETE FROM thread_messages WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ?)",
    ).run(projectId);

    await db.prepare(
      "DELETE FROM task_deps WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?) OR depends_on IN (SELECT id FROM tasks WHERE project_id = ?)",
    ).run(projectId, projectId);
    for (const table of ["evidence", "attempts", "task_notes", "steers"] as const) {
      await db.prepare(`DELETE FROM ${table} WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`).run(projectId);
    }
    await db.prepare("DELETE FROM attention_alerts WHERE project_id = ?").run(projectId);
    await db.prepare("UPDATE decision_log SET task_id = NULL WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").run(projectId);
    await db.prepare("UPDATE questions SET task_id = NULL WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").run(projectId);
    await db.prepare("UPDATE memory_log SET task_id = NULL WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").run(projectId);
    await wipeProjectMemory(db, projectId);
    for (const table of ["questions", "decision_log", "mediator_usage", "jobs", "catchup_watermarks", "project_context_domains"] as const) {
      await db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
    }
    await db.prepare("DELETE FROM threads WHERE project_id = ?").run(projectId);
    await db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
    await db.prepare("DELETE FROM oauth_seats WHERE project_id = ?").run(projectId);

    // better-auth tables may be absent in unit tests without initAuth. When
    // present, API keys are user-owned (not FK-owned); metadata is the scope.
    try {
      const keys = await db.prepare("SELECT id, metadata FROM apikey").all<{ id: string; metadata: string | null }>();
      for (const key of keys) {
        if (apiKeyProjectId(key.metadata) === projectId) {
          await db.prepare("DELETE FROM apikey WHERE id = ?").run(key.id);
        }
      }
      await db.prepare('DELETE FROM "invitation" WHERE "organizationId" = ?').run(projectId);
      await db.prepare('DELETE FROM "member" WHERE "organizationId" = ?').run(projectId);
      await db.prepare('DELETE FROM "organization" WHERE id = ?').run(projectId);
    } catch {
      // better-auth schema not installed — project tables already purged above.
    }
    const deleted = await db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    if (deleted.changes !== 1) throw new Error(`project ${projectId} was concurrently removed`);
  });
}
