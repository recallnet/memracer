import type { Db } from "../db.js";
import { MemoryStore } from "./memory.js";
import type { ProjectKnowledgeDomain, ProjectKnowledgeTrigger } from "./project-knowledge.js";

export const QUESTION_LEDGER_PATH = "questions/open-questions.md";

export interface ProjectQuestionInput {
  question: string;
  domain: ProjectKnowledgeDomain;
  trigger: ProjectKnowledgeTrigger;
}

interface QuestionRow {
  id: number;
  task_id: number | null;
  asked_by: string;
  question: string;
  answer: string | null;
  status: "open" | "answered";
  domain: string | null;
  refresh_trigger: string | null;
}

/** Collapse whitespace so prompt text matches ledger-normalized questions. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const SUBJECT_STOP_WORDS = new Set([
  "a", "an", "and", "are", "be", "can", "do", "does", "for", "how", "i", "in",
  "is", "it", "of", "on", "or", "our", "should", "the", "this", "to", "we",
  "what", "when", "which", "who", "why", "would", "you", "your",
]);

function subjectTokens(value: string): Set<string> {
  const normalized = oneLine(value)
    .toLowerCase()
    .replace(/recommended:[\s\S]*$/, "")
    .replace(/[^a-z0-9]+/g, " ");
  const aliases: Record<string, string> = {
    matters: "priority",
    prioritize: "priority",
    prioritized: "priority",
    prioritise: "priority",
    sequencing: "order",
    sequence: "order",
  };
  return new Set(normalized.split(" ")
    .map((token) => aliases[token] ?? token)
    .filter((token) => token.length > 1 && !SUBJECT_STOP_WORDS.has(token)));
}

function sameSubject(left: string, right: string): boolean {
  const a = subjectTokens(left);
  const b = subjectTokens(right);
  if (a.size < 2 || b.size < 2) return oneLine(left).toLowerCase() === oneLine(right).toLowerCase();
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared >= 2 && shared / Math.min(a.size, b.size) >= 0.75;
}

function isHumanAsk(value: string, askedBy: string): boolean {
  if (/^(?:answered|decided|resolved|resolution)\s*:/i.test(value)) return false;
  return value.includes("?") || askedBy !== "mediator";
}

/**
 * Operational questions live in the questions table. This service projects
 * their current state into one deterministic OKF concept for mediator recall.
 */
export class QuestionLedger {
  private readonly memory: MemoryStore;

  constructor(private readonly db: Db) {
    this.memory = new MemoryStore(db);
  }

  /** Add task or project questions and return their stable ids. */
  async add(
    projectId: string,
    taskId: number | null,
    askedBy: string,
    questions: string | string[] | ProjectQuestionInput | ProjectQuestionInput[],
  ): Promise<number[]> {
    const values = (Array.isArray(questions) ? questions : [questions])
      .map((value) => typeof value === "string"
        ? { question: oneLine(value), domain: null, trigger: null }
        : { question: oneLine(value.question), domain: value.domain, trigger: value.trigger })
      .filter((value) => Boolean(value.question));
    const ids: number[] = [];
    await this.db.transaction(async () => {
      for (const value of values) {
        const { question, domain, trigger } = value;
        if (!isHumanAsk(question, askedBy)) continue;
        const prior = await this.db
          .prepare("SELECT id, task_id, question, status FROM questions WHERE project_id=? ORDER BY id")
          .all<Pick<QuestionRow, "id" | "task_id" | "question" | "status">>(projectId);
        const duplicate = prior.find((row) =>
          row.task_id === taskId && (domain !== null ? row.status === "open" : true) && sameSubject(row.question, question)
        );
        if (duplicate) {
          if (duplicate.status === "open") ids.push(duplicate.id);
          continue;
        }
        const decisions = await this.db
          .prepare("SELECT task_id, summary, rationale FROM decision_log WHERE project_id=? ORDER BY id DESC")
          .all<{ task_id: number | null; summary: string; rationale: string }>(projectId);
        const alreadyDecided = domain === null && decisions.some((row) =>
          (row.task_id === taskId || row.task_id === null) &&
          (sameSubject(row.summary, question) || sameSubject(row.rationale, question))
        );
        if (alreadyDecided) continue;
        const inserted = await this.db
          .prepare(
            `INSERT INTO questions (project_id, task_id, asked_by, question, created_at, domain, refresh_trigger)
             VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
          )
          .get<{ id: number }>(projectId, taskId, askedBy, question, Date.now(), domain, trigger);
        const existing =
          inserted ??
          (taskId === null
            ? await this.db
                .prepare(
                  `SELECT id FROM questions
                  WHERE project_id=? AND task_id IS NULL AND status='open'
                    AND (question=? OR (CAST(? AS TEXT) IS NOT NULL AND domain=?)) ORDER BY id LIMIT 1`,
                )
                .get<{ id: number }>(projectId, question, domain, domain)
            : undefined);
        if (existing) ids.push(existing.id);
      }
      if (ids.length > 0) await this.sync(projectId);
    });
    if (ids.length > 0) {
      // Best-effort Web Push for new open questions (task #418). Await so the
      // work cannot leak past the caller's transaction / request boundary.
      const { scheduleProjectAttentionPush } = await import("../push-dispatch.js");
      await scheduleProjectAttentionPush(this.db, projectId);
    }
    return ids;
  }

  /** Rewrite the living concept from current DB rows; no second writable truth. */
  async sync(projectId: string): Promise<void> {
    const rows = await this.db
      .prepare(
        `SELECT id, task_id, asked_by, question, answer, status, domain, refresh_trigger
         FROM questions WHERE project_id=? AND status='open' ORDER BY id`,
      )
      .all<QuestionRow>(projectId);
    if (rows.length === 0) {
      await this.memory.remove(projectId, QUESTION_LEDGER_PATH);
      return;
    }
    const entries = rows.map((q) => {
      const task = q.task_id === null ? "project" : `task #${q.task_id}`;
      const domain = q.domain ? `, domain ${q.domain}, trigger ${q.refresh_trigger}` : "";
      const lines = [
        `- [${q.status}] Q${q.id} (${task}, asked by ${q.asked_by}${domain}): ${oneLine(q.question)}`,
      ];
      if (q.answer !== null) lines.push(`  - Answer: ${oneLine(q.answer)}`);
      return lines.join("\n");
    });
    await this.memory.upsert(projectId, {
      path: QUESTION_LEDGER_PATH,
      type: "Reference",
      title: "Open questions ledger",
      description: "Project and task questions awaiting answers",
      tags: ["questions", "product", "users", "priorities", "stage", "context"],
      body: [
        "# Questions",
        "",
        ...entries,
        "",
        "# Related",
        "",
        "- [Project memory index](../index.md)",
      ].join("\n"),
    });
  }
}
