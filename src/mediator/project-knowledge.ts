import type { Db } from "../db.js";

export const PROJECT_KNOWLEDGE_DOMAINS = [
  {
    id: "product-bounds",
    label: "Product and bounds",
    description: "Purpose, users, value, scope boundaries, and explicit non-goals.",
    refreshAfterMs: 180 * 24 * 60 * 60 * 1000,
    signals: ["product", "scope", "user", "value", "non-goal", "boundary"],
  },
  {
    id: "priorities-roadmap",
    label: "Priorities and roadmap",
    description: "Current ordering, stage, milestones, next outcomes, and deprioritized work.",
    refreshAfterMs: 30 * 24 * 60 * 60 * 1000,
    signals: ["priority", "roadmap", "stage", "milestone", "direction", "next"],
  },
  {
    id: "team-people",
    label: "Team and people",
    description: "Who participates, who owns durable decisions, and what expertise is available.",
    refreshAfterMs: 30 * 24 * 60 * 60 * 1000,
    signals: ["team", "people", "owner", "member", "expertise"],
  },
  {
    id: "roles-collaboration",
    label: "Roles and collaboration",
    description: "Responsibilities, handoffs, review expectations, and collaboration boundaries.",
    refreshAfterMs: 30 * 24 * 60 * 60 * 1000,
    signals: ["role", "collaboration", "handoff", "review", "responsibility"],
  },
  {
    id: "architecture-tech",
    label: "Architecture and technology",
    description: "System shape, repositories, services, data flows, and durable technology choices.",
    refreshAfterMs: 90 * 24 * 60 * 60 * 1000,
    signals: ["architecture", "tech", "service", "repository", "data flow", "component"],
  },
  {
    id: "constraints-invariants",
    label: "Constraints and invariants",
    description: "Security, compatibility, reliability, policy, and behavior that must not regress.",
    refreshAfterMs: 90 * 24 * 60 * 60 * 1000,
    signals: ["constraint", "invariant", "security", "compatibility", "risk", "must not"],
  },
  {
    id: "domain-vocabulary",
    label: "Domain and vocabulary",
    description: "Business concepts, terms of art, and distinctions agents must use consistently.",
    refreshAfterMs: 180 * 24 * 60 * 60 * 1000,
    signals: ["domain", "vocabulary", "glossary", "terminology", "definition"],
  },
  {
    id: "history-decisions-learnings",
    label: "History, decisions, and learnings",
    description: "Why the project is shaped this way, settled decisions, reversals, and recurring lessons.",
    refreshAfterMs: 60 * 24 * 60 * 60 * 1000,
    signals: ["history", "decision", "learning", "rationale", "changed", "retrospective"],
  },
  {
    id: "operational-external",
    label: "Operational and external context",
    description: "Active integrations, deployment environments, external dependencies, and operational commitments.",
    refreshAfterMs: 30 * 24 * 60 * 60 * 1000,
    signals: ["operation", "deploy", "integration", "external", "github", "environment"],
  },
  {
    id: "preferences-felt-experience",
    label: "Preferences and felt experience",
    description: "Durable product taste, workflow friction, quality expectations, and user-reported experience.",
    refreshAfterMs: 90 * 24 * 60 * 60 * 1000,
    signals: ["preference", "experience", "friction", "quality", "taste", "workflow"],
  },
] as const;

export type ProjectKnowledgeDomain = (typeof PROJECT_KNOWLEDGE_DOMAINS)[number]["id"];
export type ProjectKnowledgeTrigger = "TIME" | "EVENTS" | "STALENESS";

const DOMAIN_IDS = new Set<string>(PROJECT_KNOWLEDGE_DOMAINS.map((domain) => domain.id));
export const PROJECT_KNOWLEDGE_BATCH_SIZE = 3;
/** Bare periodic refresh throttle. Event/answer-driven enqueues ignore this. */
export const PROJECT_KNOWLEDGE_SWEEP_MS = 24 * 60 * 60 * 1000;
export const PROJECT_KNOWLEDGE_CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const PROJECT_KNOWLEDGE_OPEN_QUESTION_STALE_MS = 30 * 24 * 60 * 60 * 1000;
export const PROJECT_KNOWLEDGE_TASK_EVENT_THRESHOLD = 5;

export function isProjectKnowledgeDomain(value: unknown): value is ProjectKnowledgeDomain {
  return typeof value === "string" && DOMAIN_IDS.has(value);
}

export interface ProjectKnowledgeCandidate {
  domain: ProjectKnowledgeDomain;
  label: string;
  description: string;
  last_refreshed_at: number | null;
  last_checked_at: number | null;
  triggers: ProjectKnowledgeTrigger[];
  reasons: string[];
  concepts: Array<{ path: string; title: string; updated_at: number }>;
  open_question: { id: number; question: string; created_at: number } | null;
  event_generation: number;
}

interface DomainStateRow {
  domain: string;
  last_refreshed_at: number | null;
  last_checked_at: number | null;
  dirty_since: number | null;
  dirty_reason: string | null;
  requested_generation: number;
  applied_generation: number;
}

interface MemoryRow {
  path: string;
  title: string;
  description: string;
  tags: string;
  updated_at: number;
}

function searchableMemory(row: MemoryRow): string {
  let tags = "";
  try {
    const parsed = JSON.parse(row.tags) as unknown;
    tags = Array.isArray(parsed) ? parsed.map(String).join(" ") : String(parsed ?? "");
  } catch {
    tags = row.tags;
  }
  return `${row.path} ${row.title} ${row.description} ${tags}`.toLowerCase();
}

/**
 * Heuristic evidence routing only. It helps rank stale concepts; it never
 * chooses an OKF path or forces a mediator write. Explicit domain:<id> tags
 * win, and a concept may inform more than one domain.
 */
export function domainsForMemoryDoc(row: MemoryRow): ProjectKnowledgeDomain[] {
  const haystack = searchableMemory(row);
  const explicit = PROJECT_KNOWLEDGE_DOMAINS
    .filter((domain) => haystack.includes(`domain:${domain.id}`))
    .map((domain) => domain.id);
  if (explicit.length > 0) return explicit;
  return PROJECT_KNOWLEDGE_DOMAINS
    .filter((domain) => domain.signals.some((signal) => haystack.includes(signal)))
    .map((domain) => domain.id);
}

function appendReason(existing: string | null, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!clean) return existing ?? "project event";
  const values = (existing ?? "").split(" | ").filter(Boolean);
  if (!values.includes(clean)) values.push(clean);
  return values.slice(-4).join(" | ");
}

export class ProjectKnowledgeState {
  constructor(private readonly db: Db) {}

  async ensure(projectId: string): Promise<void> {
    for (const domain of PROJECT_KNOWLEDGE_DOMAINS) {
      await this.db
        .prepare(
          `INSERT INTO project_context_domains (project_id, domain)
           VALUES (?, ?) ON CONFLICT (project_id, domain) DO NOTHING`,
        )
        .run(projectId, domain.id);
    }
  }

  async markEvent(
    projectId: string,
    domains: ProjectKnowledgeDomain[],
    reason: string,
    now = Date.now(),
  ): Promise<Array<{ domain: ProjectKnowledgeDomain; generation: number }>> {
    await this.ensure(projectId);
    return this.db.transaction(async () => {
      const generations: Array<{ domain: ProjectKnowledgeDomain; generation: number }> = [];
      for (const domain of [...new Set(domains)].sort()) {
        const row = await this.db
          .prepare(
            `SELECT dirty_reason FROM project_context_domains WHERE project_id=? AND domain=?${
              this.db.dialect === "postgres" ? " FOR UPDATE" : ""
            }`,
          )
          .get<{ dirty_reason: string | null }>(projectId, domain);
        const updated = await this.db
          .prepare(
            `UPDATE project_context_domains
                SET dirty_since=COALESCE(dirty_since, ?), dirty_reason=?,
                    requested_generation=requested_generation+1
              WHERE project_id=? AND domain=?
              RETURNING requested_generation`,
          )
          .get<{ requested_generation: number }>(now, appendReason(row?.dirty_reason ?? null, reason), projectId, domain);
        generations.push({ domain, generation: updated!.requested_generation });
      }
      return generations;
    });
  }

  async candidates(projectId: string, now = Date.now()): Promise<ProjectKnowledgeCandidate[]> {
    await this.ensure(projectId);
    const states = await this.db
      .prepare(
        `SELECT domain, last_refreshed_at, last_checked_at, dirty_since, dirty_reason,
                requested_generation, applied_generation
           FROM project_context_domains WHERE project_id=?`,
      )
      .all<DomainStateRow>(projectId);
    const byDomain = new Map(states.map((state) => [state.domain, state]));
    const lastProjectCheck = states.reduce<number | null>(
      (latest, state) => state.last_checked_at !== null && (latest === null || state.last_checked_at > latest)
        ? state.last_checked_at
        : latest,
      null,
    );
    const globalCooldownElapsed = lastProjectCheck === null || now - lastProjectCheck >= PROJECT_KNOWLEDGE_CHECK_COOLDOWN_MS;
    const docs = await this.db
      .prepare(
        `SELECT path, title, description, tags, updated_at FROM memory_docs
          WHERE project_id=? AND path <> 'questions/open-questions.md' ORDER BY updated_at, path`,
      )
      .all<MemoryRow>(projectId);
    const concepts = new Map<ProjectKnowledgeDomain, ProjectKnowledgeCandidate["concepts"]>();
    for (const row of docs) {
      for (const domain of domainsForMemoryDoc(row)) {
        const list = concepts.get(domain) ?? [];
        list.push({ path: row.path, title: row.title, updated_at: row.updated_at });
        concepts.set(domain, list);
      }
    }
    const questions = await this.db
      .prepare(
        `SELECT id, domain, question, created_at FROM questions
          WHERE project_id=? AND task_id IS NULL AND status='open' AND domain IS NOT NULL
          ORDER BY created_at, id`,
      )
      .all<{ id: number; domain: string; question: string; created_at: number }>(projectId);
    const openByDomain = new Map(
      questions.filter((question) => isProjectKnowledgeDomain(question.domain)).map((question) => [question.domain, question]),
    );
    const changedTasks = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT id) AS n FROM tasks
          WHERE project_id=? AND state='DONE' AND updated_at > COALESCE(
            (SELECT MAX(last_checked_at) FROM project_context_domains WHERE project_id=?), 0
          )`,
      )
      .get<{ n: number | string }>(projectId, projectId);
    const taskBurst = Number(changedTasks?.n ?? 0) >= PROJECT_KNOWLEDGE_TASK_EVENT_THRESHOLD;

    const ranked: ProjectKnowledgeCandidate[] = [];
    for (const definition of PROJECT_KNOWLEDGE_DOMAINS) {
      const state = byDomain.get(definition.id)!;
      const domainConcepts = concepts.get(definition.id) ?? [];
      const open = openByDomain.get(definition.id) ?? null;
      const triggers = new Set<ProjectKnowledgeTrigger>();
      const reasons: string[] = [];
      const cooldownElapsed = globalCooldownElapsed;

      if (state.requested_generation > state.applied_generation) {
        triggers.add("EVENTS");
        reasons.push(state.dirty_reason ?? "project event since the last check");
      }
      if (taskBurst && ["priorities-roadmap", "architecture-tech", "history-decisions-learnings"].includes(definition.id)) {
        triggers.add("EVENTS");
        reasons.push(`${Number(changedTasks?.n ?? 0)} tasks completed since the last project-knowledge check`);
      }
      if (state.last_refreshed_at !== null && now - state.last_refreshed_at >= definition.refreshAfterMs && cooldownElapsed) {
        triggers.add("TIME");
        reasons.push(`domain knowledge is older than ${Math.round(definition.refreshAfterMs / 86_400_000)} days`);
      }
      if (state.last_refreshed_at === null && cooldownElapsed) {
        triggers.add("STALENESS");
        reasons.push("domain has never been refreshed");
      }
      const oldConcept = domainConcepts.find((concept) => now - concept.updated_at >= definition.refreshAfterMs);
      if (oldConcept && cooldownElapsed) {
        triggers.add("STALENESS");
        reasons.push(`oldest related concept is ${oldConcept.path}`);
      }
      if (open && now - open.created_at >= PROJECT_KNOWLEDGE_OPEN_QUESTION_STALE_MS && cooldownElapsed) {
        triggers.add("STALENESS");
        reasons.push(`open question Q${open.id} is older than 30 days`);
      }
      if (triggers.size === 0) continue;
      ranked.push({
        domain: definition.id,
        label: definition.label,
        description: definition.description,
        last_refreshed_at: state.last_refreshed_at,
        last_checked_at: state.last_checked_at,
        triggers: [...triggers],
        reasons,
        concepts: domainConcepts.slice(0, 8),
        open_question: open ? { id: open.id, question: open.question, created_at: open.created_at } : null,
        event_generation: state.requested_generation,
      });
    }

    return ranked.sort((left, right) => {
      const leftAt = left.last_refreshed_at ?? Number.NEGATIVE_INFINITY;
      const rightAt = right.last_refreshed_at ?? Number.NEGATIVE_INFINITY;
      if (leftAt !== rightAt) return leftAt - rightAt;
      const leftChecked = left.last_checked_at ?? Number.NEGATIVE_INFINITY;
      const rightChecked = right.last_checked_at ?? Number.NEGATIVE_INFINITY;
      if (leftChecked !== rightChecked) return leftChecked - rightChecked;
      return PROJECT_KNOWLEDGE_DOMAINS.findIndex((domain) => domain.id === left.domain)
        - PROJECT_KNOWLEDGE_DOMAINS.findIndex((domain) => domain.id === right.domain);
    });
  }

  /**
   * An answered question must reach curation even when another refresh already
   * consumed its event generation. This constructs a current server-owned
   * candidate without changing clocks or minting another event.
   */
  async answerCandidate(
    projectId: string,
    domain: ProjectKnowledgeDomain,
    questionId: number,
  ): Promise<ProjectKnowledgeCandidate> {
    await this.ensure(projectId);
    const state = (await this.db.prepare(
      `SELECT domain, last_refreshed_at, last_checked_at, dirty_since, dirty_reason,
              requested_generation, applied_generation
         FROM project_context_domains WHERE project_id=? AND domain=?`,
    ).get<DomainStateRow>(projectId, domain))!;
    const definition = PROJECT_KNOWLEDGE_DOMAINS.find((candidate) => candidate.id === domain)!;
    const docs = await this.db.prepare(
      `SELECT path, title, description, tags, updated_at FROM memory_docs
        WHERE project_id=? AND path <> 'questions/open-questions.md' ORDER BY updated_at, path`,
    ).all<MemoryRow>(projectId);
    const concepts = docs
      .filter((doc) => domainsForMemoryDoc(doc).includes(domain))
      .map((doc) => ({ path: doc.path, title: doc.title, updated_at: doc.updated_at }))
      .slice(0, 8);
    return {
      domain,
      label: definition.label,
      description: definition.description,
      last_refreshed_at: state.last_refreshed_at,
      last_checked_at: state.last_checked_at,
      triggers: ["EVENTS"],
      reasons: [`human answered project question Q${questionId}; curation is required`],
      concepts,
      open_question: null,
      event_generation: state.requested_generation,
    };
  }

  async recordCheck(
    projectId: string,
    checked: Array<{ domain: ProjectKnowledgeDomain; event_generation: number }>,
    refreshed: ProjectKnowledgeDomain[],
    now = Date.now(),
    curatedQuestionId?: number,
  ): Promise<void> {
    await this.ensure(projectId);
    const refreshedSet = new Set(refreshed);
    await this.db.transaction(async () => {
      for (const check of new Map(checked.map((value) => [value.domain, value])).values()) {
        const domain = check.domain;
        await this.db
          .prepare(
            `UPDATE project_context_domains
                SET last_checked_at=?,
                    last_refreshed_at=CASE WHEN ?=1 THEN ? ELSE last_refreshed_at END,
                    applied_generation=CASE
                      WHEN applied_generation < ? THEN ? ELSE applied_generation END,
                    dirty_since=CASE WHEN requested_generation <= ? THEN NULL ELSE dirty_since END,
                    dirty_reason=CASE WHEN requested_generation <= ? THEN NULL ELSE dirty_reason END
              WHERE project_id=? AND domain=?`,
          )
          .run(
            now,
            refreshedSet.has(domain) ? 1 : 0,
            now,
            check.event_generation,
            check.event_generation,
            check.event_generation,
            check.event_generation,
            projectId,
            domain,
          );
      }
      if (curatedQuestionId !== undefined) {
        const curated = await this.db.prepare(
          `UPDATE questions SET curated_at=?
            WHERE id=? AND project_id=? AND task_id IS NULL
              AND status='answered' AND answer IS NOT NULL AND curated_at IS NULL`,
        ).run(now, curatedQuestionId, projectId);
        if (curated.changes !== 1) {
          throw new Error(`project question Q${curatedQuestionId} is not pending curation`);
        }
      }
    });
  }
}
