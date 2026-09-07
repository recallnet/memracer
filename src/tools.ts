import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Member, Membership, Role } from "./auth.js";
import type { Db } from "./db.js";
import type { MediatorWorker } from "./mediator/worker.js";
import { parseWindowSpec, type WindowSpec } from "./mediator/pipelines.js";
import { ProjectKnowledgeState, isProjectKnowledgeDomain } from "./mediator/project-knowledge.js";
import { MemoryStore } from "./mediator/memory.js";
import { Queue, DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS, parseWarmFor, type TaskRow } from "./queue.js";
import { parsePrUrl, type PrVerifier } from "./github-pr.js";
import { ConversationStore } from "./conversations.js";
import { AttentionAlertService } from "./attention-alerts.js";
import { NegotiationStore } from "./negotiation.js";
import {
  listHumanAttention,
  presentHumanStatusAttention,
} from "./human-attention.js";
import {
  CODER_ROLE_CONTRACT,
  HUMAN_ROLE_CONTRACT,
} from "./dashboard/public/role-contracts.js";
import { presentTaskBriefActors, projectActorLabel, projectActorLabels } from "./present-task-brief.js";
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  ImageAttachmentService,
  UnavailableImageBlobStore,
  type ImageMimeType,
} from "./image-attachments.js";
import { meaningfulSubmissionText, submissionContentMessage } from "./submission-content.js";
import {
  assertProjectInferenceReadyForMcp,
  projectHasUsableByokInference,
} from "./inference-credentials.js";

const evidenceSchema = z.object({
  kind: z.enum(["code", "stacktrace", "log", "link", "research"]),
  path: z.string().optional(),
  lines: z.string().optional(),
  snippet: z.string().optional(),
  note: z.string().optional(),
});

const imageMimeSchema = z.enum(IMAGE_MIME_TYPES);
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const HUMAN_JOB_KINDS = new Set(["groom", "discuss", "catchup", "seal", "enhance", "conciliate", "refresh"]);
const RESOURCE_LIST_LIMIT = 100;
const PENDING_CLARIFICATIONS_LIMIT = 5;
const PENDING_CLARIFICATIONS_DESCRIPTION =
  "Every successful human_* response also includes your bounded pending_clarifications. Answer those with human_answer before moving on.";

function resourceVariable(value: string | string[], label: string): string {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error(`malformed ${label}`);
    return value[0];
  }
  return value;
}

function positiveResourceId(value: string | string[], label: string): number {
  const raw = resourceVariable(value, label);
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`malformed ${label}`);
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw new Error(`malformed ${label}`);
  return id;
}

function resourceListMeta(total: number, returned: number) {
  return {
    limit: RESOURCE_LIST_LIMIT,
    total,
    returned,
    truncated: total > returned,
  };
}

function hasImageSignature(bytes: Uint8Array, mimeType: ImageMimeType): boolean {
  if (mimeType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((byte, index) => bytes[index] === byte);
  }
  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    const header = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  return (
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  );
}

/** Strict standard-base64 decoder for the one MCP upload call. */
export function decodeImageBase64(value: string, mimeType: ImageMimeType): Uint8Array {
  if (value.length === 0) throw new Error("image_base64 must not be empty");
  if (value.length > MAX_IMAGE_BASE64_CHARS) {
    throw new Error(`image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
  }
  if (value.length % 4 !== 0) {
    throw new Error("image_base64 must be canonical padded base64 without whitespace");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error("image_base64 must be canonical padded base64 without whitespace");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
  }
  if (!hasImageSignature(bytes, mimeType)) {
    throw new Error(`image bytes do not match ${mimeType}`);
  }
  return bytes;
}

function imageFetchUrl(publicUrl: string | undefined, projectId: string, attachmentId: number): string {
  const pathname = `/p/${encodeURIComponent(projectId)}/images/${attachmentId}`;
  if (!publicUrl) return pathname;
  try {
    const url = new URL(publicUrl);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return pathname;
  }
}

/** True when a discuss message is really a "catch me up" request for a windowed digest. */
function isCatchupRequest(message: string): boolean {
  return /\bcatch me up\b|\bcatch-up\b|\bcatchup\b|\bwhat('?s| has)? changed\b|\bwhat happened\b|\bwhat did i miss\b/i.test(
    message,
  );
}

function json(result: unknown) {
  // Compact on purpose: pretty-printed JSON inside SSE data lines confused a
  // cold agent's line-based parser in simulation round 1.
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

const MEDIATOR_WAIT_CAP_MS = 90_000;
/** Human groom wait stays longer so wait=true often finishes in one call. */
const MEDIATOR_GROOM_WAIT_DEFAULT_MS = 60_000;
/**
 * Coder plan/ask default wait is short so a pending review does not freeze the
 * agent turn for a full minute. Agents re-enter with the same args (or pass
 * wait_s up to the cap when they choose to block).
 */
const MEDIATOR_REVIEW_WAIT_DEFAULT_MS = 15_000;
/** Suggested sleep before the next poll when status is pending. */
export const MEDIATOR_POLL_AFTER_MS = 2_000;

export type MediatorWaitEnv = "MEMRACER_GROOM_WAIT_MS" | "MEMRACER_REVIEW_WAIT_MS";
export type IncompleteLoopName = "plan_review" | "plan_rereview" | "mediator_answer" | "mediator_generic";

/** Bounded synchronous wait for mediator tools. Optional wait_s (seconds) overrides env default. */
export function mediatorWaitMs(envName: MediatorWaitEnv, waitS?: number): number {
  if (waitS !== undefined && Number.isFinite(waitS)) {
    return Math.max(1, Math.min(Math.floor(waitS * 1000), MEDIATOR_WAIT_CAP_MS));
  }
  const fallback = envName === "MEMRACER_REVIEW_WAIT_MS"
    ? MEDIATOR_REVIEW_WAIT_DEFAULT_MS
    : MEDIATOR_GROOM_WAIT_DEFAULT_MS;
  const configured = Number(process.env[envName] ?? fallback);
  if (!Number.isFinite(configured)) return fallback;
  return Math.max(1, Math.min(Math.floor(configured), MEDIATOR_WAIT_CAP_MS));
}

export interface IncompleteLoopNext {
  tool: string;
  mode: "reenter_same";
  args_hint: string;
}

const LOOP_NEXT: Record<IncompleteLoopName, IncompleteLoopNext> = {
  plan_review: {
    tool: "coder_propose_plan",
    mode: "reenter_same",
    args_hint: "Same task_id + plan (+ files_touched/risk). Short re-enter; wait_s only for off-model pollers.",
  },
  plan_rereview: {
    tool: "coder_answer",
    mode: "reenter_same",
    args_hint: "If still pending after answer, re-call coder_propose_plan with the same plan; do not start coding.",
  },
  mediator_answer: {
    tool: "coder_ask",
    mode: "reenter_same",
    args_hint: "Same task_id + question. Optional wait_s 1–90.",
  },
  mediator_generic: {
    tool: "same tool",
    mode: "reenter_same",
    args_hint: "Re-call this tool with the same arguments; you get the completed result, not a duplicate job.",
  },
};

function pendingInstruction(loop: IncompleteLoopName): string {
  const base =
    "Mediator still working. Re-call the same tool with the SAME arguments after ~2s " +
    "(default ~15s). Re-enter soon; do not park a main agent turn on wait_s=90 — that freezes the session. " +
    "Off-model pollers may pass wait_s≤90. You will get the completed result, not a duplicate job.";
  if (loop === "plan_review" || loop === "plan_rereview") {
    return (
      `${base} Do NOT implement code yet. Do NOT claim another task. You MAY read code for this task. ` +
      "Terminal outcomes are only approved | revise | clarify."
    );
  }
  if (loop === "mediator_answer") {
    return `${base} Do not treat this as escalated until the terminal result says so.`;
  }
  return base;
}

/** Attach next-step guidance to a finished plan/answer payload. */
export function enrichTerminalMediatorResult(
  result: Record<string, unknown>,
  loop: IncompleteLoopName,
): Record<string, unknown> {
  const verdict = typeof result.verdict === "string" ? result.verdict : null;
  const escalated = result.escalated === true;
  let instruction: string | undefined;
  if (loop === "plan_review" || loop === "plan_rereview") {
    if (verdict === "approved") {
      instruction =
        "Plan approved. Implement now. Keep coder_heartbeat renewing the lease; call coder_progress at milestones; coder_complete with the PR when done.";
    } else if (verdict === "revise") {
      instruction =
        "Plan needs revision. Do NOT implement. Address feedback, then re-call coder_propose_plan with an updated plan.";
    } else if (verdict === "clarify") {
      instruction =
        "Frigg needs a decision. Do NOT implement. Call coder_answer with your answer, then continue until approved or revise.";
    }
  } else if (loop === "mediator_answer") {
    if (escalated) {
      instruction =
        "Escalated to humans. Call coder_park so you can pull other work; the task requeues when answered.";
    } else {
      instruction = "Mediator answered. Apply the answer to this task; continue plan/implement as appropriate.";
    }
  }
  if (!instruction) return result;
  return { ...result, instruction };
}

export function jobResult(
  job: { status: string; result: string | null; error: string | null; id: number },
  opts?: { loop?: IncompleteLoopName },
) {
  const loop = opts?.loop ?? "mediator_generic";
  if (job.status === "done") {
    const parsed = JSON.parse(job.result!) as Record<string, unknown>;
    return enrichTerminalMediatorResult(parsed, loop);
  }
  if (job.status === "failed") throw new Error(`mediator job ${job.id} failed: ${job.error}`);
  const next = LOOP_NEXT[loop];
  return {
    status: "pending" as const,
    job_id: job.id,
    loop,
    poll_after_ms: MEDIATOR_POLL_AFTER_MS,
    wait_s_default: Math.round(MEDIATOR_REVIEW_WAIT_DEFAULT_MS / 1000),
    wait_s_max: Math.round(MEDIATOR_WAIT_CAP_MS / 1000),
    next,
    instruction: pendingInstruction(loop),
    // Back-compat one-liner for older agents
    note: pendingInstruction(loop),
  };
}

function backgroundJob(job: { status: string; result: string | null; error: string | null; id: number }) {
  return {
    job_id: job.id,
    status: job.status,
    ...(job.status === "done" ? { result: JSON.parse(job.result!) } : {}),
    ...(job.status === "failed" ? { error: job.error } : {}),
  };
}

function describeProjects(memberships: Membership[]): string {
  return memberships
    .map((m) => `${m.projectId} ("${m.projectName}"${m.repo ? `, repo ${m.repo}` : ""})`)
    .join("; ");
}

function projectParam(memberships: Membership[]) {
  const ids = memberships.map((m) => m.projectId) as [string, ...string[]];
  return z
    .enum(ids)
    .optional()
    .describe(
      `Target project. Omit only when unambiguous (single project, or a repo match). Your projects: ${describeProjects(memberships)}. When working in a git repo, infer the project whose repo matches.`,
    );
}

const humanStatusSectionSchema = z.enum([
  "attention_alerts",
  "projects",
  "open_questions",
  "open_conversations",
]);

function compactStatusTask(task: TaskRow) {
  return {
    id: task.id,
    project_id: task.project_id,
    title: task.title,
    priority: task.priority,
    state: task.state,
    submitted_by: task.submitted_by,
    lease_agent: task.lease_agent,
    lease_expires_at: task.lease_expires_at,
    result_pr_url: task.result_pr_url,
    parent_id: task.parent_id,
    incubate_until: task.incubate_until,
    queued_at: task.queued_at,
    waiting_on: task.waiting_on ?? [],
    operational: task.operational ?? null,
  };
}

function resolveProject(
  memberships: Membership[],
  explicit: string | undefined,
  repo: string | undefined,
): string {
  if (explicit) {
    const m = memberships.find((m) => m.projectId === explicit);
    if (!m) {
      throw new Error(
        `not a member of project '${explicit}'; your projects: ${describeProjects(memberships)}`,
      );
    }
    return m.projectId;
  }
  if (repo) {
    const m = memberships.find((m) => m.repo === repo);
    if (m) return m.projectId;
  }
  if (memberships.length === 1) return memberships[0].projectId;
  throw new Error(
    `ambiguous project — pass 'project' as one of: ${describeProjects(memberships)}`,
  );
}

/**
 * Connect-time role onboarding, surfaced by Claude Code as the MCP server's
 * `instructions`. It tells the session its role and — for humans — how to clear
 * open questions over MCP without opening the dashboard. Plain text only.
 */
/** An active warming task a connecting human could join (#62 onboarding hook). */
export interface ActiveIncubation {
  id: number;
  title: string;
  projectId: string;
}

export function roleInstructions(member: Member, incubations: ActiveIncubation[] = []): string {
  const { name, memberships } = member;
  const isHuman = memberships.some((m) => m.role === "human" || m.role === "admin");
  const isCoder = memberships.some((m) => m.role === "coder" || m.role === "admin");
  const projectList = memberships
    .map((m) => `- ${m.projectName} (${m.projectId})${m.repo ? ` — ${m.repo}` : ""}: ${m.role}`)
    .join("\n");

  const blocks: string[] = [
    `You are connected to memracer as ${name}. Your projects and roles:`,
    projectList,
  ];

  if (isHuman) {
    blocks.push(HUMAN_ROLE_CONTRACT);
    // Onboarding hook (#62): surface warming tasks anyone can join. A warming
    // (INCUBATING) task sits off the coder queue while its spec is shaped;
    // human_enhance lets any project human contribute research, scope changes,
    // or cuts, and the mediator arbitrates before it graduates to claimable.
    if (incubations.length > 0) {
      blocks.push(
        [
          "WARMING TASKS you can shape right now (call human_enhance(task_id, contribution) to contribute — Frigg merges, refuses, or clarifies each contribution before the task graduates):",
          ...incubations.map((t) => `- #${t.id} (${t.projectId}): ${t.title}`),
        ].join("\n"),
      );
    }
  }

  if (isCoder) {
    blocks.push(CODER_ROLE_CONTRACT);
  }

  return blocks.join("\n\n");
}

export function buildServer(
  queue: Queue,
  member: Member,
  worker: MediatorWorker,
  db: Db,
  incubations: ActiveIncubation[] = [],
  publicUrl?: string,
  imageAttachments = new ImageAttachmentService(db, new UnavailableImageBlobStore()),
  /** When set, coder_complete verifies the PR against GitHub (fail-closed). */
  prVerifier?: PrVerifier | null,
): McpServer {
  const server = new McpServer(
    { name: "memracer", version: "0.0.1" },
    { instructions: roleInstructions(member, incubations) },
  );
  const { name, memberships } = member;
  // A user may mint several coder keys. The verified key id, not the shared
  // user name, owns a lease; the key name is the label shown to people.
  const leaseAgent = member.keyId ?? name;
  const conversations = new ConversationStore(db, queue);
  const attentionAlerts = new AttentionAlertService(db, publicUrl);
  const projectKnowledge = new ProjectKnowledgeState(db);
  const memory = new MemoryStore(db);
  const humanMs = memberships.filter((m) => m.role === "human" || m.role === "admin");
  const coderMs = memberships.filter((m) => m.role === "coder" || m.role === "admin");
  const coderProjectIds = coderMs.map((m) => m.projectId);
  /** BYOK-only gate for MCP tools — no host OPENROUTER fallback (see assertProjectInferenceReadyForMcp). */
  const requireMcpInference = (projectId: string) => assertProjectInferenceReadyForMcp(db, projectId);
  const filterByokProjects = async (projectIds: string[]): Promise<string[]> => {
    const ready: string[] = [];
    for (const id of projectIds) {
      if (await projectHasUsableByokInference(db, id)) ready.push(id);
    }
    return ready;
  };
  const taskAck = (taskId: number) => db
    .prepare(
      `SELECT id, project_id, title, state, priority, incubate_until, grooming_rationale
       FROM tasks WHERE id=?`,
    )
    .get<{
      id: number;
      project_id: string;
      title: string;
      state: string;
      priority: number;
      incubate_until: number | null;
      grooming_rationale: string | null;
    }>(taskId);

  const humanJson = async (result: Record<string, unknown>, cursor = 0) => {
    const rows = await db
      .prepare(
        `SELECT q.id AS question_id, q.task_id, t.title AS task_title, q.question,
                COUNT(*) OVER () AS total
         FROM questions q JOIN tasks t ON t.id=q.task_id
         WHERE q.status='open' AND q.asked_by='mediator' AND t.submitted_by=?
           AND q.project_id IN (${humanMs.map(() => "?").join(",")})
         ORDER BY q.id ASC LIMIT ? OFFSET ?`,
      )
      .all<{
        question_id: number;
        task_id: number;
        task_title: string;
        question: string;
        total: number;
      }>(name, ...humanMs.map((membership) => membership.projectId), PENDING_CLARIFICATIONS_LIMIT, cursor);
    const total = Number(rows[0]?.total ?? 0);
    const pendingClarifications = rows.map(({ total: _total, ...question }) => question);
    const nextCursor = cursor + pendingClarifications.length < total
      ? cursor + pendingClarifications.length
      : null;
    return json({
      ...result,
      pending_clarifications: pendingClarifications,
      pending_clarifications_page: {
        cursor,
        limit: PENDING_CLARIFICATIONS_LIMIT,
        returned: pendingClarifications.length,
        total,
        next_cursor: nextCursor,
      },
    });
  };

  // Tasks as MCP resources: @-mentionable in Claude Code as @memracer:task://<id>.
  // Scoped to the member's projects; queried per call — the server is stateless.
  const memberProjectIds = memberships.map((m) => m.projectId);
  const membershipByProject = new Map(memberships.map((membership) => [membership.projectId, membership]));
  const resourceNotFound = () => new Error("resource not found in your projects");
  server.registerResource(
    "task",
    new ResourceTemplate("task://{id}", {
      list: async () => {
        const rows = await db
          .prepare(
            `SELECT id, title, state, project_id FROM tasks
             WHERE project_id IN (${memberProjectIds.map(() => "?").join(",")})
             ORDER BY id ASC LIMIT ?`,
          )
          .all<{ id: number; title: string; state: string; project_id: string }>(...memberProjectIds, RESOURCE_LIST_LIMIT);
        return {
          resources: rows.map((t) => ({
            uri: `task://${t.id}`,
            name: `#${t.id} ${t.title}`,
            description: `[${t.project_id}] ${t.state}`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Task brief",
      description: "A memracer task's full brief: body, evidence, attempts, questions, notes.",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      const taskId = positiveResourceId(id, "task id");
      const brief = await queue.brief(taskId);
      if (!brief.id || !memberProjectIds.includes(brief.project_id)) {
        throw resourceNotFound();
      }
      const presentedBrief = await presentTaskBriefActors(db, brief);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(presentedBrief) }],
      };
    },
  );

  server.registerResource(
    "project",
    new ResourceTemplate("project://{id}", {
      list: async () => ({
        resources: memberships.slice(0, RESOURCE_LIST_LIMIT).map((membership) => ({
          uri: `project://${membership.projectId}`,
          name: membership.projectName,
          description: `${membership.role} access to ${membership.projectId}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Project metadata",
      description: "Safe metadata for one project available to this API key.",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      const projectId = resourceVariable(id, "project id");
      const membership = membershipByProject.get(projectId);
      if (!membership) throw resourceNotFound();
      const project = await db.prepare("SELECT id, name, repo FROM projects WHERE id=?").get<{
        id: string;
        name: string;
        repo: string | null;
      }>(projectId);
      if (!project) throw resourceNotFound();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ ...project, role: membership.role }),
        }],
      };
    },
  );

  server.registerResource(
    "queue",
    new ResourceTemplate("queue://{project}", {
      list: async () => ({
        resources: memberships.slice(0, RESOURCE_LIST_LIMIT).map((membership) => ({
          uri: `queue://${membership.projectId}`,
          name: `${membership.projectName} queue`,
          description: "Compact bounded queue snapshot",
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Queue snapshot",
      description: "A compact, bounded, read-only queue snapshot for one project.",
      mimeType: "application/json",
    },
    async (uri, { project }) => {
      const projectId = resourceVariable(project, "project id");
      if (!membershipByProject.has(projectId)) throw resourceNotFound();
      const count = await db.prepare("SELECT count(*) AS count FROM tasks WHERE project_id=?").get<{ count: number }>(projectId);
      const counts = await db.prepare(
        "SELECT state, count(*) AS count FROM tasks WHERE project_id=? GROUP BY state ORDER BY state",
      ).all<{ state: string; count: number }>(projectId);
      const tasks = await db.prepare(
        `SELECT id, title, state, priority, submitted_by, lease_agent, lease_expires_at,
                parent_id, incubate_until, queued_at, created_at, updated_at, result_pr_url
         FROM tasks WHERE project_id=?
         ORDER BY CASE WHEN state='DONE' THEN 1 ELSE 0 END, priority ASC, id ASC LIMIT ?`,
      ).all<Record<string, unknown>>(projectId, RESOURCE_LIST_LIMIT);
      const actorLabels = await projectActorLabels(
        db,
        tasks.flatMap((task) => typeof task.lease_agent === "string"
          ? [{ actor: task.lease_agent, projectId }]
          : []),
      );
      const presentedTasks = tasks.map((task) => ({
        ...task,
        lease_agent: typeof task.lease_agent === "string"
          ? projectActorLabel(actorLabels, task.lease_agent, projectId) ?? task.lease_agent
          : null,
      }));
      const total = Number(count?.count ?? 0);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            project_id: projectId,
            ...resourceListMeta(total, presentedTasks.length),
            state_counts: Object.fromEntries(counts.map((row) => [row.state, Number(row.count)])),
            tasks: presentedTasks,
          }),
        }],
      };
    },
  );

  server.registerResource(
    "question",
    new ResourceTemplate("question://{id}", {
      list: async () => {
        const rows = await db.prepare(
          `SELECT id, project_id, question, status FROM questions
           WHERE project_id IN (${memberProjectIds.map(() => "?").join(",")})
           ORDER BY id DESC LIMIT ?`,
        ).all<{ id: number; project_id: string; question: string; status: string }>(
          ...memberProjectIds,
          RESOURCE_LIST_LIMIT,
        );
        return {
          resources: rows.map((question) => ({
            uri: `question://${question.id}`,
            name: `Question #${question.id}`,
            description: `[${question.project_id}] ${question.status}: ${question.question}`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Durable question",
      description: "One open or answered human question from the durable ledger.",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      const questionId = positiveResourceId(id, "question id");
      const question = await db.prepare(
        `SELECT id, project_id, task_id, asked_by, question, answer, answered_by, status,
                created_at, domain, answered_at
         FROM questions WHERE id=?`,
      ).get<Record<string, unknown> & { project_id: string }>(questionId);
      if (!question || !membershipByProject.has(question.project_id)) throw resourceNotFound();
      const actorLabels = typeof question.asked_by === "string"
        ? await projectActorLabels(db, [{ actor: question.asked_by, projectId: question.project_id }])
        : new Map<string, string>();
      const presentedQuestion = {
        ...question,
        asked_by: typeof question.asked_by === "string"
          ? projectActorLabel(actorLabels, question.asked_by, question.project_id) ?? question.asked_by
          : question.asked_by,
      };
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(presentedQuestion) }],
      };
    },
  );

  server.registerResource(
    "okf",
    new ResourceTemplate("okf://{project}/{+path}", {
      list: async () => {
        const resources: Array<{ uri: string; name: string; description: string; mimeType: string }> = [];
        for (const membership of memberships) {
          const remaining = RESOURCE_LIST_LIMIT - resources.length;
          if (remaining <= 0) break;
          const docs = await db.prepare(
            `SELECT path, title, description FROM memory_docs
             WHERE project_id=? ORDER BY path LIMIT ?`,
          ).all<{ path: string; title: string; description: string }>(membership.projectId, remaining);
          const indexPaths = new Set<string>();
          const addIndex = (path: string) => {
            if (indexPaths.has(path) || resources.length >= RESOURCE_LIST_LIMIT) return;
            indexPaths.add(path);
            resources.push({
              uri: `okf://${membership.projectId}/${path}`,
              name: `${membership.projectName} / ${path}`,
              description: "Generated OKF index",
              mimeType: "text/markdown",
            });
          };
          addIndex("index.md");
          for (const doc of docs) {
            const directories = doc.path.split("/").slice(0, -1);
            for (let depth = 1; depth <= directories.length; depth += 1) {
              addIndex(`${directories.slice(0, depth).join("/")}/index.md`);
            }
            if (resources.length >= RESOURCE_LIST_LIMIT) break;
            resources.push({
              uri: `okf://${membership.projectId}/${doc.path}`,
              name: doc.title,
              description: doc.description,
              mimeType: "text/markdown",
            });
          }
        }
        return { resources: resources.slice(0, RESOURCE_LIST_LIMIT) };
      },
    }),
    {
      title: "Project knowledge",
      description: "A generated OKF index or DB-backed project knowledge concept.",
      mimeType: "text/markdown",
    },
    async (uri, { project, path }) => {
      const projectId = resourceVariable(project, "project id");
      const memoryPath = resourceVariable(path, "OKF path");
      if (!membershipByProject.has(projectId) || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*\.md$/.test(memoryPath)) {
        throw resourceNotFound();
      }
      let text: string | undefined;
      if (memoryPath === "index.md" || memoryPath.endsWith("/index.md")) {
        text = (await memory.renderIndexes(projectId)).get(memoryPath);
      } else {
        const doc = await memory.get(projectId, memoryPath);
        text = doc ? memory.renderConcept(doc) : undefined;
      }
      if (text === undefined) throw resourceNotFound();
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );

  server.registerTool(
    "list_projects",
    {
      description:
        "List the projects this member belongs to: id, display name, associated repo, and role. Use it to navigate projects or map the current git repo to a project.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => json({ member: name, projects: memberships }),
  );

  if (humanMs.length > 0) {
    const submitResponse = async (
      result: Record<string, unknown>,
      jobId: number | null,
      wait: boolean | undefined,
    ) => {
      if (!wait || jobId === null) return humanJson(result);
      const job = await worker.waitForJob(jobId, mediatorWaitMs("MEMRACER_GROOM_WAIT_MS"));
      const taskId = Number(result.task_id);
      const task = Number.isInteger(taskId) ? await taskAck(taskId) : null;
      // Echo the groom's grounded reading (Phase 4): when the groom accept is
      // available, surface its extraction so the submitter can confirm the
      // reading before leaving. No result yet (no-wait / timeout) → no reading.
      const groom = job.status === "done" && job.result
        ? (JSON.parse(job.result) as {
            extraction?: { subject: string; in_scope: string[]; out_of_scope: string[] };
          })
        : undefined;
      const reading = groom?.extraction
        ? {
            subject: groom.extraction.subject,
            in_scope: groom.extraction.in_scope,
            out_of_scope: groom.extraction.out_of_scope,
            confirm_prompt: `I read this as: "${groom.extraction.subject}". Is this what you meant? If not, reply to correct it before a coder picks it up.`,
          }
        : undefined;
      return humanJson({
        ...result,
        state: ["pending", "running"].includes(job.status) ? "GROOMING" : task?.state ?? result.state,
        grooming: backgroundJob(job),
        ...(reading ? { reading } : {}),
      });
    };

    server.registerTool(
      "human_submit",
      {
        description:
          `Prefer wait=true when you can block briefly: wait up to 90 seconds for the first groom verdict, reading, or clarification inline (timeout falls back to GROOMING). Without wait, returns immediately with task_id, GROOMING, and job_id. Either way, stay for Frigg follow-ups — drain pending_clarifications, answer reading confirms, use human_task_status / human_discuss; do not disconnect after the first handoff. Wait is for the groom window only, not memory consolidation. Optional warm_for (1h/1d/1w or ISO-8601, e.g. PT30M) files work INCUBATING off the coder queue without encoding hold in the title. Optional idempotency_key makes retries return the same task. ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: {
          project: projectParam(humanMs),
          title: z.string().refine(meaningfulSubmissionText, submissionContentMessage("title")),
          body: z.string().refine(meaningfulSubmissionText, submissionContentMessage("body")).describe("What to do and why; include acceptance criteria"),
          priority: z.number().int().min(0).max(3).optional().describe("0 = highest"),
          repo: z.string().optional().describe("Repo you are working in, e.g. owner/name — used to infer the project"),
          base_sha: z.string().optional(),
          idempotency_key: z.string().trim().min(1).max(200).optional(),
          wait: z.boolean().optional().describe("Wait up to the configured 90-second cap for the groom result"),
          evidence: z.array(evidenceSchema).default([]),
          warm_for: z
            .string()
            .optional()
            .describe(
              "Warming period: 1h/1d/1w or an ISO-8601 duration (e.g. PT30M). Race-free hold — task is born INCUBATING off the coder queue with a live countdown, then graduates to claimable via a seal groom. Prefer this over submit-then-human_warm_task.",
            ),
        },
      },
      async (args) => {
        const projectId = resolveProject(humanMs, args.project, args.repo);
        await requireMcpInference(projectId);
        const warmForMs = args.warm_for ? parseWarmFor(args.warm_for) : undefined;
        const existingId = args.idempotency_key
          ? await queue.findSubmissionByKey(projectId, name, args.idempotency_key)
          : null;
        if (existingId !== null) {
          const payload = { taskId: existingId, submittedBy: name };
          const existingJob = await worker.findLatestJob(projectId, "groom", payload);
          const task = await taskAck(existingId);
          return submitResponse({
            task_id: existingId,
            state: existingJob && ["pending", "running"].includes(existingJob.status) ? "GROOMING" : task?.state,
            job_id: existingJob?.id ?? null,
            idempotent_replay: true,
            task,
          }, existingJob?.id ?? null, args.wait);
        }
        // Deterministic dedup before anything is created: a same-submitter,
        // in-window resubmission of the same content is not a new task. If the
        // original is blocked awaiting a mediator clarification, tell the
        // submitter in-band which task and question to answer — do not fork,
        // and do not open a second question (double-ask suppression).
        const dup = await queue.findDuplicate(projectId, name, args.title, args.body);
        if (dup) {
          if (args.idempotency_key) {
            const mappedId = await queue.rememberSubmissionKey(projectId, name, args.idempotency_key, dup.id);
            if (mappedId !== dup.id) {
              const mappedJob = await worker.findLatestJob(projectId, "groom", { taskId: mappedId, submittedBy: name });
              const mappedTask = await taskAck(mappedId);
              return submitResponse({
                task_id: mappedId,
                state: mappedJob && ["pending", "running"].includes(mappedJob.status) ? "GROOMING" : mappedTask?.state,
                job_id: mappedJob?.id ?? null,
                idempotent_replay: true,
                task: mappedTask,
              }, mappedJob?.id ?? null, args.wait);
            }
          }
          const pending = await queue.pendingMediatorQuestion(dup.id);
          if (pending) {
            return humanJson({
              status: "needs_clarification",
              duplicate_of: dup.id,
              task_id: dup.id,
              task: dup,
              question: pending.question,
              question_id: pending.id,
              instruction: `This duplicates task #${dup.id}, which is blocked awaiting your clarification: ${pending.question} Answer it via human_answer(question_id: ${pending.id}); do not resubmit.`,
            });
          }
          return humanJson({
            status: "duplicate",
            duplicate_of: dup.id,
            task_id: dup.id,
            task: dup,
            instruction: `This duplicates existing task #${dup.id} (${dup.state}); not creating a new task.`,
          });
        }
        const input = {
          title: args.title,
          body: args.body,
          priority: args.priority,
          repo: args.repo,
          baseSha: args.base_sha,
          evidence: args.evidence,
          warmForMs,
        };
        const submitted = args.idempotency_key
          ? await queue.submitIdempotent(projectId, name, args.idempotency_key, input)
          : { id: await queue.submit(projectId, name, input), created: true };
        const id = submitted.id;
        if (!submitted.created) {
          const existingJob = await worker.findLatestJob(projectId, "groom", { taskId: id, submittedBy: name });
          const task = await taskAck(id);
          return submitResponse({
            task_id: id,
            state: existingJob && ["pending", "running"].includes(existingJob.status) ? "GROOMING" : task?.state,
            job_id: existingJob?.id ?? null,
            idempotent_replay: true,
            task,
          }, existingJob?.id ?? null, args.wait);
        }
        const jobId = await worker.findOrEnqueue(projectId, "groom", { taskId: id, submittedBy: name });
        return submitResponse({
          task_id: id,
          state: "GROOMING",
          job_id: jobId,
          idempotent_replay: false,
          task: await taskAck(id),
        }, jobId, args.wait);
      },
    );

    server.registerTool(
      "human_job_status",
      {
        description: `Fetch one background human mediator job by id. Returns a small pending/running/done/failed result. ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: { job_id: z.number().int().positive() },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        const job = await worker.getJob(args.job_id);
        if (
          !job ||
          !HUMAN_JOB_KINDS.has(job.kind) ||
          !humanMs.some((m) => m.projectId === job.project_id)
        ) {
          throw new Error(`job ${args.job_id} not found in your projects`);
        }
        return humanJson(backgroundJob(job));
      },
    );

    server.registerTool(
      "human_task_status",
      {
        description: `Fetch one task and its latest groom status/result without loading project-wide human_status. ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: { task_id: z.number().int().positive() },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        const task = await db
          .prepare(
            `SELECT t.*, COALESCE(t.repo, p.repo) AS repo
             FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?`,
          )
          .get<{ id: number; project_id: string; submitted_by: string; state: string }>(args.task_id);
        if (!task || !humanMs.some((m) => m.projectId === task.project_id)) {
          throw new Error(`task ${args.task_id} not found in your projects`);
        }
        const job = await worker.findLatestJob(task.project_id, "groom", {
          taskId: task.id,
          submittedBy: task.submitted_by,
        });
        return humanJson({
          task: { ...task, state: job && ["pending", "running"].includes(job.status) ? "GROOMING" : task.state },
          grooming: job ? backgroundJob(job) : null,
        });
      },
    );

    server.registerTool(
      "human_attach_image",
      {
        description:
          `Attach one private screenshot to an existing task. The base64 exists only in this call; memracer stores opaque bytes in R2 and metadata in the task evidence ledger. PNG, JPEG, GIF, or WebP; 10 MiB decoded maximum. ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: {
          task_id: z.number().int().positive(),
          image_base64: z
            .string()
            .describe("Canonical padded base64 for one image; no data-URL prefix or whitespace"),
          mimeType: imageMimeSchema,
          caption: z.string().max(1_000).optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        const task = await db
          .prepare("SELECT project_id FROM tasks WHERE id = ?")
          .get<{ project_id: string }>(args.task_id);
        if (!task) throw new Error(`task ${args.task_id} not found`);
        if (!humanMs.some((membership) => membership.projectId === task.project_id)) {
          throw new Error(`not a member of task ${args.task_id}'s project`);
        }
        const bytes = decodeImageBase64(args.image_base64, args.mimeType);
        const caption = args.caption?.trim() || null;
        const attachment = await imageAttachments.attach({
          projectId: task.project_id,
          taskId: args.task_id,
          bytes,
          mimeType: args.mimeType,
          caption,
        });
        queue.notifyChanged(task.project_id);
        return humanJson({
          attached: true,
          task_id: args.task_id,
          image: {
            id: attachment.id,
            mimeType: attachment.mimeType,
            caption: attachment.caption,
          },
        });
      },
    );

    // Load an INCUBATING task and confirm the caller may steer its warming
    // clock: the submitter, or an admin of the task's project (#61). Throws a
    // clear message otherwise so the tool surfaces the reason to the human.
    const requireIncubationControl = async (
      taskId: number,
    ): Promise<{ projectId: string }> => {
      const task = await db
        .prepare("SELECT project_id, submitted_by, state FROM tasks WHERE id=?")
        .get<{ project_id: string; submitted_by: string; state: string }>(taskId);
      if (!task) throw new Error(`task ${taskId} not found`);
      const membership = humanMs.find((m) => m.projectId === task.project_id);
      if (!membership) throw new Error(`not a member of task ${taskId}'s project`);
      const isAdmin = memberships.some((m) => m.projectId === task.project_id && m.role === "admin");
      if (task.submitted_by !== name && !isAdmin) {
        throw new Error(`only ${task.submitted_by} (the submitter) or a project admin can steer task ${taskId}'s warming period`);
      }
      if (task.state !== "INCUBATING") {
        throw new Error(`task ${taskId} is ${task.state}, not INCUBATING`);
      }
      return { projectId: task.project_id };
    };

    // A submitted QUEUED task may enter warming after submission. Authorization
    // matches the other warming-clock controls: submitter or project admin.
    // State is checked after authorization so a non-member learns nothing
    // about another project's task lifecycle.
    const requireWarmControl = async (
      taskId: number,
    ): Promise<{ state: string }> => {
      const task = await db
        .prepare("SELECT project_id, submitted_by, state FROM tasks WHERE id=?")
        .get<{ project_id: string; submitted_by: string; state: string }>(taskId);
      if (!task) throw new Error(`task ${taskId} not found`);
      const membership = humanMs.find((m) => m.projectId === task.project_id);
      if (!membership) throw new Error(`not a member of task ${taskId}'s project`);
      const isAdmin = memberships.some((m) => m.projectId === task.project_id && m.role === "admin");
      if (task.submitted_by !== name && !isAdmin) {
        throw new Error(`only ${task.submitted_by} (the submitter) or a project admin can warm task ${taskId}`);
      }
      return { state: task.state };
    };

    server.registerTool(
      "human_warm_task",
      {
        description:
          `Move an existing QUEUED task into a warming (INCUBATING) period so humans can improve its spec before coders claim it. The transition is atomic: it cannot take a task away from a coder who already claimed it. Submitter or project admin only. ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: {
          task_id: z.number().int().describe("The QUEUED task to warm"),
          warm_for: z.string().describe("Warming period from now: 1h/1d/1w or ISO-8601 (e.g. PT30M)"),
        },
      },
      async (args) => {
        const task = await requireWarmControl(args.task_id);
        if (task.state !== "QUEUED") {
          const guidance =
            task.state === "INCUBATING"
              ? "it is already warming; use human_extend_incubation to add time or human_seal_incubation to graduate it"
              : task.state === "DONE"
                ? "finished tasks cannot be warmed; use human_followup to create a linked task"
                : task.state === "HELD"
                  ? "held tasks cannot be warmed; use human_discuss to reopen it to QUEUED, then warm it"
                : "only an unclaimed QUEUED task can enter warming; wait for the current lifecycle action to finish";
          throw new Error(`task ${args.task_id} is ${task.state}, not QUEUED — ${guidance}`);
        }
        const warmForMs = parseWarmFor(args.warm_for);
        const warmed = await queue.warm(args.task_id, Date.now() + warmForMs);
        if (!warmed) {
          const current = await queue.brief(args.task_id);
          throw new Error(
            `task ${args.task_id} changed from QUEUED to ${current.state} before warming could start — no change was made; refresh with human_status`,
          );
        }
        return humanJson({ warmed: true, task: await queue.brief(args.task_id) });
      },
    );

    // Enhancing a warming task is open to ANY project human, not just the
    // submitter (#62): the warming period is collaborative. Gate on membership
    // of the task's project + INCUBATING state only.
    const requireIncubationMember = async (taskId: number): Promise<{ projectId: string }> => {
      const task = await db
        .prepare("SELECT project_id, state FROM tasks WHERE id=?")
        .get<{ project_id: string; state: string }>(taskId);
      if (!task) throw new Error(`task ${taskId} not found`);
      const membership = humanMs.find((m) => m.projectId === task.project_id);
      if (!membership) throw new Error(`not a member of task ${taskId}'s project`);
      if (task.state !== "INCUBATING") {
        throw new Error(`task ${taskId} is ${task.state}, not INCUBATING — only warming tasks can be enhanced`);
      }
      return { projectId: task.project_id };
    };

    server.registerTool(
      "human_enhance",
      {
        description:
          `Contribute to a warming task and return immediately with a background job_id. Any project human may contribute; fetch the eventual verdict with human_job_status. ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: {
          task_id: z.number().int().describe("The INCUBATING task to enhance"),
          contribution: z
            .string()
            .describe("Your contribution: research/evidence to attach, a proposed scope change, or an argument for a cut"),
        },
      },
      async (args) => {
        const { projectId } = await requireIncubationMember(args.task_id);
        await requireMcpInference(projectId);
        const jobId = await worker.findOrEnqueue(projectId, "enhance", {
          taskId: args.task_id,
          contribution: args.contribution,
          from: name,
        });
        return humanJson({ task_id: args.task_id, state: "PROCESSING", job_id: jobId });
      },
    );

    server.registerTool(
      "human_seal_incubation",
      {
        description:
          `Seal a warming (INCUBATING) task early: graduate it to QUEUED now, before its clock strikes, so coders can claim it. Submitter or project admin only. ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: { task_id: z.number().int().describe("The INCUBATING task to seal") },
      },
      async (args) => {
        await requireIncubationControl(args.task_id);
        await queue.sealEarly(args.task_id);
        return humanJson({ sealed: true, task: await queue.brief(args.task_id) });
      },
    );

    server.registerTool(
      "human_extend_incubation",
      {
        description:
          `Extend a warming (INCUBATING) task's period: push its graduation clock out by warm_for (1h/1d/1w or an ISO-8601 duration), measured from now. Submitter or project admin only. ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: {
          task_id: z.number().int().describe("The INCUBATING task to extend"),
          warm_for: z.string().describe("New remaining warming period from now: 1h/1d/1w or ISO-8601 (e.g. PT30M)"),
        },
      },
      async (args) => {
        await requireIncubationControl(args.task_id);
        const extendMs = parseWarmFor(args.warm_for);
        await queue.extendIncubation(args.task_id, Date.now() + extendMs);
        return humanJson({ extended: true, task: await queue.brief(args.task_id) });
      },
    );

    // Prompts surface in Claude Code as /mcp__memracer__submit and
    // /mcp__memracer__status slash commands for human sessions.
    server.registerPrompt(
      "submit",
      {
        title: "Submit an idea to the queue",
        description: "Turn an idea into a well-evidenced memracer task via human_submit.",
        argsSchema: { idea: z.string().describe("The idea or problem to submit") },
      },
      ({ idea }) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Submit this idea to the memracer queue: ${idea}`,
                "",
                "First gather evidence from the repo you are working in: file:line references,",
                "code snippets, stack traces, or links that ground the idea. Then call the",
                "memracer 'human_submit' tool with a crisp title, a body that states what to do,",
                "why, and acceptance criteria, the evidence you collected, and the repo",
                "(owner/name) so the project resolves. Report the immediate task id, then",
                "fetch its mediator verdict with human_task_status and report that outcome.",
              ].join("\n"),
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "status",
      {
        title: "Queue status",
        description: "Summarize attention alerts, task states, leases, and open questions.",
        argsSchema: {},
      },
      () => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Call the memracer 'human_status' tool and summarize the result for the user:",
                "lead with any attention_alerts for queued work that has no active project coder,",
                "tasks grouped by state (queued, in flight with lease owner, done), priorities",
                "worth flagging, and any open questions that need a human answer (offer to",
                "answer them via 'human_answer').",
              ].join("\n"),
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "answer",
      {
        title: "Answer a durable question",
        description: "Inspect a durable question and answer it through human_answer.",
        argsSchema: {
          question_id: z.string().regex(/^[1-9]\d*$/).describe("The durable question id"),
          answer: z.string().min(1).describe("The human's answer"),
        },
      },
      ({ question_id, answer }) => ({
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Read question://${question_id} to confirm the durable question and its current status.`,
              `Then call human_answer with question_id ${question_id} and this answer: ${answer}`,
              "Report the durable acknowledgement and any background job id; do not wait synchronously for mediator work.",
            ].join("\n"),
          },
        }],
      }),
    );

    server.registerPrompt(
      "review",
      {
        title: "Review task work",
        description: "Review a task and its delivered change without taking over mediator approval.",
        argsSchema: {
          task_id: z.string().regex(/^[1-9]\d*$/).describe("The task id to review"),
          focus: z.string().optional().describe("Optional review focus"),
        },
      },
      ({ task_id, focus }) => ({
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Read task://${task_id}, inspect its evidence and result, and verify the relevant repository change.`,
              focus ? `Focus the review on: ${focus}` : "Review correctness, regressions, security, and missing tests.",
              "Report findings with concrete file and line references, ordered by severity.",
              "The mediator remains the sole approver of coder plans; this review must not approve, reject, or submit a coder plan.",
              "Corrections must happen at plan approval before execution; after approval, file a new task or a followup after this task is DONE.",
            ].join("\n"),
          },
        }],
      }),
    );

    server.registerTool(
      "human_status",
      {
        description:
          `Bounded queue status plus durable attention alerts, open questions, and conversations. Tasks are compact and paginated by default; request task_detail='full' only when full task rows are needed. ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: {
          project: projectParam(humanMs),
          sections: z.array(humanStatusSectionSchema).min(1).max(4).optional().describe(
            "Top-level sections to return. Omit for all sections.",
          ),
          task_detail: z.enum(["compact", "full"]).optional().describe(
            "Task row detail for the projects section. Defaults to compact operational fields.",
          ),
          task_limit: z.number().int().min(1).max(100).optional().describe(
            "Maximum tasks returned per project. Defaults to 50.",
          ),
          task_offset: z.number().int().min(0).optional().describe(
            "Zero-based task offset applied within every selected project. Defaults to 0.",
          ),
          attention_limit: z.number().int().min(1).max(100).optional().describe(
            "Maximum compact attention items returned. Defaults to 50.",
          ),
          attention_cursor: z.number().int().min(0).optional().describe(
            "Zero-based cursor into the ordered attention list. Defaults to 0; continue with attention_page.next_cursor.",
          ),
          pending_clarifications_cursor: z.number().int().min(0).optional().describe(
            "Continue the bounded pending_clarifications page from a previous human_* response's next_cursor.",
          ),
        },
      },
      async (args) => {
        const statusProjects = args.project
          ? [resolveProject(humanMs, args.project, undefined)]
          : humanMs.map((m) => m.projectId);
        const byokStatusProjects = await filterByokProjects(statusProjects);
        if (byokStatusProjects.length === 0) {
          // Fail closed with Org Settings message (shared MCP BYOK gate).
          await requireMcpInference(statusProjects[0]!);
        }
        const sections = new Set(args.sections ?? humanStatusSectionSchema.options);
        const taskDetail = args.task_detail ?? "compact";
        const taskLimit = args.task_limit ?? 50;
        const taskOffset = args.task_offset ?? 0;
        const attentionLimit = args.attention_limit ?? 50;
        const attentionCursor = args.attention_cursor ?? 0;
        // Scope status to BYOK-ready projects only — never leak non-BYOK siblings.
        const readySet = new Set(byokStatusProjects);
        const projects = (
          args.project
            ? [humanMs.find((m) => m.projectId === resolveProject(humanMs, args.project, undefined))!]
            : humanMs
        ).filter((m) => readySet.has(m.projectId));
        // Project onboarding/refresh is asynchronous and adaptive. Status
        // requests schedule one coalesced mediator pass; they never mint a
        // fixed questionnaire in the request path.
        for (const project of projects) {
          if ((await projectKnowledge.candidates(project.projectId)).length > 0) {
            await worker.findOrEnqueue(project.projectId, "refresh", { mode: "refresh" });
          }
        }
        const openQuestions = await db
          .prepare(
            `SELECT q.id, q.task_id, q.asked_by, q.question, q.project_id,
                    t.title AS task_title
             FROM questions q LEFT JOIN tasks t ON t.id = q.task_id
             WHERE q.status='open' AND q.project_id IN (${projects.map(() => "?").join(",")})`,
          )
          .all<{ id: number; task_id: number | null; asked_by: string; question: string; project_id: string; task_title: string | null }>(...projects.map((m) => m.projectId));
        const rawStatuses = await Promise.all(
          projects.map(async (project) => ({ project, status: await queue.status(project.projectId) })),
        );
        const actorLabels = await projectActorLabels(db, [
          ...openQuestions.map((question) => ({ actor: question.asked_by, projectId: question.project_id })),
          ...rawStatuses.flatMap(({ project, status }) => status.tasks.flatMap((task) => task.lease_agent
            ? [{ actor: task.lease_agent, projectId: project.projectId }]
            : [])),
        ]);
        const presentedQuestions = openQuestions.map((question) => ({
          ...question,
          asked_by: projectActorLabel(actorLabels, question.asked_by, question.project_id) ?? question.asked_by,
        }));
        const statuses: Record<string, unknown> = {};
        for (const { project, status } of rawStatuses) {
          const presentedTasks = status.tasks.map((task) => ({
            ...task,
            lease_agent: task.lease_agent === null
              ? null
              : projectActorLabel(actorLabels, task.lease_agent, project.projectId) ?? task.lease_agent,
          }));
          const tasks = presentedTasks
            .slice(taskOffset, taskOffset + taskLimit)
            .map((task) => taskDetail === "full" ? task : compactStatusTask(task));
          const nextOffset = taskOffset + tasks.length < presentedTasks.length
            ? taskOffset + tasks.length
            : null;
          statuses[project.projectId] = {
            name: project.projectName,
            tasks,
            task_page: {
              detail: taskDetail,
              offset: taskOffset,
              limit: taskLimit,
              returned: tasks.length,
              total: presentedTasks.length,
              next_offset: nextOffset,
            },
          };
        }
        // Open multi-human conflict conversations across the caller's projects
        // (#77): each with its participants (and who has replied), the
        // conflicting task ids, and the discussion so far, so a human sees it
        // and can reply via human_conversation_reply — no dashboard needed.
        const openConversations = (
          await conversations.listOpenForProjects(projects.map((m) => m.projectId))
        ).map((c) => ({
          conversation_id: c.id,
          project: c.project_id,
          topic: c.topic,
          deadline: c.deadline,
          task_ids: c.task_ids,
          participants: c.participants,
          awaiting_reply_from: c.participants.filter((p) => p.replied_at == null).map((p) => p.member),
          messages: c.messages,
        }));
        // Canonical attention (task #418): same builder as dashboard NeedsYou
        // and Web Push — queue episodes, open questions, conflicts, blocked.
        const projectNames = new Map(projects.map((project) => [project.projectId, project.projectName]));
        const allAttention = await listHumanAttention(db, attentionAlerts, {
          projectIds: projects.map((m) => m.projectId),
          projectNames,
          publicUrl,
          memberName: name,
          // human_status stays action-oriented: leases are dashboard-only.
          includeLeases: false,
          includeBlocked: true,
        });
        // Best-effort: human_status is also the durable evaluate path for queue
        // episodes; push dispatch dedups per endpoint+episode. Await so the
        // request path never leaks un-awaited DB work into the next transaction.
        if (allAttention.some((item) => item.pushable)) {
          const { scheduleProjectAttentionPush } = await import("./push-dispatch.js");
          for (const project of projects) {
            await scheduleProjectAttentionPush(db, project.projectId, publicUrl);
          }
        }
        const presentedAttention = allAttention
          .slice(attentionCursor, attentionCursor + attentionLimit)
          .map(presentHumanStatusAttention);
        const nextAttentionCursor = attentionCursor + presentedAttention.length < allAttention.length
          ? attentionCursor + presentedAttention.length
          : null;
        const openNegotiations = await new NegotiationStore(db).listOpenForParty(name);
        return humanJson({
          ...(sections.has("attention_alerts") ? {
            attention_alerts: presentedAttention,
            attention_page: {
              cursor: attentionCursor,
              limit: attentionLimit,
              returned: presentedAttention.length,
              total: allAttention.length,
              next_cursor: nextAttentionCursor,
            },
          } : {}),
          ...(sections.has("projects") ? { projects: statuses } : {}),
          ...(sections.has("open_questions") ? { open_questions: presentedQuestions } : {}),
          ...(sections.has("open_conversations") ? { open_conversations: openConversations } : {}),
          open_negotiations: openNegotiations.map((n) => ({
            negotiation_id: n.id,
            project: n.project_id,
            subject_kind: n.subject_kind,
            task_id: n.subject_task_id,
            state: n.state,
            current_prompt: n.current_prompt,
            note: n.current_prompt
              ? "You have an open negotiation — re-attach and answer the current_prompt."
              : "Open negotiation awaiting mediator re-run.",
          })),
        }, args.pending_clarifications_cursor ?? 0);
      },
    );

    server.registerTool(
      "human_answer",
      {
        description: `Answer an open project or task question (from the mediator or a coder). Task questions unpark their task; project questions update mediator memory. ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: { question_id: z.number().int(), answer: z.string() },
      },
      async (args) => {
        // Look up the routing before answering: a mediator clarification is a
        // groom ask-back, so answering it must continue the conversation —
        // re-groom the SAME submission rather than leave it stalled or fork a
        // new task. Other questions (coder blocks, escalations) just unpark.
        const q = await queue.questionById(args.question_id);
        if (!q || !humanMs.some((m) => m.projectId === q.project_id)) {
          throw new Error(`question ${args.question_id} not found in your projects`);
        }
        let answered: Awaited<ReturnType<typeof queue.answerQuestion>>;
        let projectRefreshJobId: number | null = null;
        if (q.task_id === null) {
          await db.transaction(async () => {
            answered = await queue.answerQuestion(args.question_id, args.answer, name);
            projectRefreshJobId = await worker.enqueue(q.project_id, "refresh", {
              mode: "answer",
              event_generations: answered.event_generations,
              answer: {
                question_id: q.id,
                question: q.question,
                answer: args.answer,
                ...(isProjectKnowledgeDomain(q.domain) ? { domain: q.domain } : {}),
              },
            });
          });
        } else {
          answered = await queue.answerQuestion(args.question_id, args.answer, name);
        }
        // Advance multi-round negotiation transcript when one is open (#441).
        let negotiationId: string | undefined;
        if (q.task_id !== null) {
          try {
            const store = new NegotiationStore(db);
            const open = await store.openForSubject(q.task_id);
            if (open && (open.state === "awaiting_party" || open.state === "awaiting_person")) {
              await store.answer(open.id, name, args.answer);
              negotiationId = open.id;
            }
          } catch {
            /* additive — question answer still stands */
          }
        }
        if (q.task_id !== null && q.asked_by === "mediator") {
          const brief = await queue.brief(q.task_id);
          const rejobId = await worker.enqueue(brief.project_id, "groom", {
            taskId: q.task_id,
            submittedBy: brief.submitted_by,
          });
          return humanJson({
            answered: args.question_id,
            regroomed: true,
            task_id: q.task_id,
            state: "GROOMING",
            job_id: rejobId,
            ...(negotiationId ? { negotiation_id: negotiationId } : {}),
          });
        }
        if (q.task_id === null) {
          return humanJson({
            answered: args.question_id,
            project: q.project_id,
            regroomed: false,
            state: "PROCESSING",
            job_id: projectRefreshJobId,
          });
        }
        return humanJson({ answered: args.question_id, project: q.project_id, regroomed: false });
      },
    );

    server.registerTool(
      "human_followup",
      {
        description:
          `Create a linked child of a DONE task and return immediately while its mediator groom runs in the background. To file the followup on record without starting it, pass optional warm_for (1h/1d/1w or ISO-8601) — the child is born INCUBATING off the coder queue. ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: {
          task_id: z.number().int(),
          title: z.string(),
          body: z.string(),
          evidence: z.array(evidenceSchema).default([]),
          warm_for: z
            .string()
            .optional()
            .describe(
              "Warming period: 1h/1d/1w or an ISO-8601 duration (e.g. PT30M). Race-free hold — child is born INCUBATING off the coder queue.",
            ),
        },
      },
      async (args) => {
        const parent = await queue.brief(args.task_id);
        if (!parent.id) throw new Error(`task ${args.task_id} not found`);
        if (parent.state !== "DONE") {
          throw new Error(`task ${args.task_id} is ${parent.state} — followup only applies to DONE tasks; after plan approval there is no reliable mid-execution correction, so submit a new task instead`);
        }
        await requireMcpInference(parent.project_id);
        const warmForMs = args.warm_for ? parseWarmFor(args.warm_for) : undefined;
        // Credit the parent author as task origin; filer still drives groom so
        // the mediator knows who filed the followup.
        const originAuthor = parent.submitted_by || name;
        const id = await queue.submit(parent.project_id, originAuthor, {
          title: args.title,
          body: args.body,
          evidence: args.evidence,
          parentId: parent.id,
          warmForMs,
        });
        const jobId = await worker.findOrEnqueue(parent.project_id, "groom", { taskId: id, submittedBy: name });
        return humanJson({
          task_id: id,
          parent_id: parent.id,
          state: "GROOMING",
          job_id: jobId,
          task: await taskAck(id),
        });
      },
    );

    server.registerTool(
      "human_discuss",
      {
        description:
          `Queue a mediator discussion or catch-up and return immediately. Fetch the eventual reply and applied/refused actions with human_job_status(job_id). ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: {
          project: projectParam(humanMs),
          message: z.string().optional(),
          since: z.enum(["today", "yesterday", "this_week", "last_7_days", "since_last_catchup"]).optional(),
        },
      },
      async (args) => {
        const projectId = resolveProject(humanMs, args.project, undefined);
        await requireMcpInference(projectId);
        const message = args.message ?? "";
        // Catch-up path: an explicit `since` window, or catch-up phrasing in the
        // message, routes to the windowed digest instead of general discuss.
        const spec: WindowSpec | undefined = args.since ?? (isCatchupRequest(message) ? parseWindowSpec(message) : undefined);
        if (spec) {
          const jobId = await worker.findOrEnqueue(projectId, "catchup", { spec, from: name });
          return humanJson({ state: "PROCESSING", job_id: jobId });
        }
        if (!message) throw new Error("human_discuss needs a message (or a `since` window for a catch-up digest)");
        const jobId = await worker.findOrEnqueue(projectId, "discuss", { message, from: name });
        return humanJson({ state: "PROCESSING", job_id: jobId });
      },
    );

    server.registerTool(
      "human_conversation_reply",
      {
        description:
          `Reply to a multi-human conflict conversation the mediator opened (see open_conversations in human_status). Your reply is recorded for the other participants, who reply from their own sessions at their own time. To signal how to resolve, include "RESOLVE: merge into <task id>", "RESOLVE: split", or "RESOLVE: hold". Once every participant has replied the mediator conciliates and closes it into a recorded decision. ${PENDING_CLARIFICATIONS_DESCRIPTION}`,
        inputSchema: {
          conversation_id: z.number().int(),
          message: z.string(),
        },
      },
      async (args) => {
        const view = await conversations.get(args.conversation_id);
        if (!view) throw new Error(`conversation ${args.conversation_id} not found`);
        if (!humanMs.some((m) => m.projectId === view.project_id)) {
          throw new Error(`conversation ${args.conversation_id} belongs to a project you are not a member of`);
        }
        if (!(await conversations.isParticipant(args.conversation_id, name))) {
          throw new Error(`you are not a participant of conversation ${args.conversation_id}`);
        }
        const updated = await conversations.reply(args.conversation_id, name, args.message);
        // The reply that completes the round triggers conciliation; earlier
        // repliers just get their reply recorded while others are still out.
        if (await conversations.allReplied(args.conversation_id)) {
          const jobId = await worker.findOrEnqueue(view.project_id, "conciliate", {
            conversationId: args.conversation_id,
          });
          return humanJson({
            recorded: true,
            all_replied: true,
            state: "PROCESSING",
            job_id: jobId,
            conversation_id: args.conversation_id,
          });
        }
        return humanJson({
          recorded: true,
          all_replied: false,
          awaiting_reply_from: updated.participants.filter((p) => p.replied_at == null).map((p) => p.member),
          conversation: updated,
        });
      },
    );
  }

  if (coderMs.length > 0) {
    server.registerPrompt(
      "drain",
      {
        title: "Drain the coder queue",
        description: "Run the complete host-neutral coder lifecycle until no work is available.",
        argsSchema: {},
      },
      () => ({
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Run the memracer coder loop as a host-neutral workflow:",
              "1. Keep coder_check_work with timeout_s=90 in one off-model background long poll; null or zero availability owns nothing and must not wake the main agent.",
              "2. When availability is positive, call coder_claim_task. A null result means another coder won the advisory race, so return to checking.",
              "3. Before editing, call coder_propose_plan and revise it until the mediator approves.",
              "4. Implement and verify the whole task, using coder_progress throughout to renew the lease and report evidence.",
              "5. Follow the repository's branch, pull request, CI, merge, release, and production-verification process, then call coder_complete with the real PR URL.",
              "6. After completion, return to coder_check_work and continue the loop.",
            ].join("\n"),
          },
        }],
      }),
    );

    server.registerTool(
      "coder_check_work",
      {
        description:
          "Read-only long-poll for claimable work, capped at 90 seconds. Returns an advisory available_count and up to peek_limit title/priority previews, but never claims or reserves a task. It is safe to abandon a pending call, and a stale positive result is harmless. Run the poll/empty/sleep/re-poll loop off-model and surface to the main agent only when available_count is positive; then call coder_claim_task explicitly.",
        inputSchema: {
          project: projectParam(coderMs),
          timeout_s: z.number().int().min(1).max(90).default(90),
          peek_limit: z.number().int().min(0).max(5).default(0),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        const requested = args.project
          ? [resolveProject(coderMs, args.project, undefined)]
          : coderProjectIds;
        const projects = await filterByokProjects(requested);
        if (projects.length === 0) {
          await requireMcpInference(requested[0]!);
        }
        const work = await queue.checkWorkAny(projects, leaseAgent, args.timeout_s, args.peek_limit);
        const openNegotiations = await new NegotiationStore(db).listOpenForParty(name);
        return json({
          ...work,
          open_negotiations: openNegotiations.map((n) => ({
            negotiation_id: n.id,
            project: n.project_id,
            subject_kind: n.subject_kind,
            task_id: n.subject_task_id,
            state: n.state,
            current_prompt: n.current_prompt,
            note: n.current_prompt
              ? "You have an open negotiation — re-attach and answer the current_prompt."
              : "Open negotiation awaiting mediator re-run.",
          })),
        });
      },
    );

    server.registerTool(
      "coder_claim_task",
      {
        description:
          "Atomically claim the next eligible task and return its full brief, or null if another coder won the advisory availability race. A null result acquires nothing; return to coder_check_work. A successful claim opens a 60-minute plan window for coder_propose_plan. Call only when you are ready to own and execute the returned task.",
        inputSchema: {
          project: projectParam(coderMs),
          lease_duration_ms: z.number().int().min(60_000).max(MAX_LEASE_TTL_MS).optional()
            .describe("Requested lease duration. Defaults to 30 minutes and is capped at 120 minutes."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        const requested = args.project
          ? [resolveProject(coderMs, args.project, undefined)]
          : coderProjectIds;
        const projects = await filterByokProjects(requested);
        if (projects.length === 0) {
          await requireMcpInference(requested[0]!);
        }
        const claimed = await queue.claimNextAny(projects, leaseAgent, args.lease_duration_ms ?? DEFAULT_LEASE_TTL_MS);
        if (!claimed) return json(null);

        const brief = await presentTaskBriefActors(db, claimed);
        const result = json(brief) as CallToolResult;
        let remainingInlineBytes = MAX_IMAGE_BYTES;
        const fallbacks: Array<{
          id: number;
          mimeType: ImageMimeType;
          caption: string | null;
          url: string;
          reason: "inline_budget" | "unavailable";
        }> = [];

        for (const attachment of await imageAttachments.list(claimed.project_id, claimed.id)) {
          if (remainingInlineBytes === 0) {
            fallbacks.push({
              id: attachment.id,
              mimeType: attachment.mimeType,
              caption: attachment.caption,
              url: imageFetchUrl(publicUrl, claimed.project_id, attachment.id),
              reason: "inline_budget",
            });
            continue;
          }
          try {
            const read = await imageAttachments.read(claimed.project_id, attachment.id);
            if (!read) throw new Error("attachment metadata disappeared");
            if (read.bytes.byteLength > remainingInlineBytes) {
              fallbacks.push({
                id: attachment.id,
                mimeType: attachment.mimeType,
                caption: attachment.caption,
                url: imageFetchUrl(publicUrl, claimed.project_id, attachment.id),
                reason: "inline_budget",
              });
              // Attachment sizes deliberately are not duplicated in SQL. Once
              // an object exhausts the ordered result budget, do not download
              // every later object merely to discover that it also will not fit.
              remainingInlineBytes = 0;
              continue;
            }
            result.content.push({
              type: "image",
              data: Buffer.from(read.bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
            remainingInlineBytes -= read.bytes.byteLength;
          } catch {
            // The lease is already durable. Blob failure degrades delivery but
            // never turns the successful atomic claim into an error.
            fallbacks.push({
              id: attachment.id,
              mimeType: attachment.mimeType,
              caption: attachment.caption,
              url: imageFetchUrl(publicUrl, claimed.project_id, attachment.id),
              reason: "unavailable",
            });
          }
        }
        if (fallbacks.length > 0) {
          result.content.push({
            type: "text",
            text: JSON.stringify({
              image_fallbacks: fallbacks,
              instruction: "Fetch with the same Bearer credential used for MCP.",
            }),
          });
        }
        return result;
      },
    );

    const requireCoderTask = async (taskId: number) => {
      const brief = await queue.brief(taskId);
      if (!brief.id) throw new Error(`task ${taskId} not found`);
      if (!coderProjectIds.includes(brief.project_id)) {
        throw new Error(`task ${taskId} belongs to a project you are not a coder on`);
      }
      await requireMcpInference(brief.project_id);
    };

    server.registerTool(
      "coder_progress",
      {
        description: "Report progress on a leased task. Renews the lease. Call at least every few minutes while working.",
        inputSchema: { task_id: z.number().int(), note: z.string() },
      },
      async (args) => {
        await requireCoderTask(args.task_id);
        const brief = await queue.progress(args.task_id, leaseAgent, args.note);
        // Explicit ack shape (round-1 finding): agents want confirmation, not
        // the whole task object echoed back.
        return json({
          ok: true,
          task_id: brief.id,
          state: brief.state,
          lease_renewed_until: brief.lease_expires_at,
        });
      },
    );

    server.registerTool(
      "coder_complete",
      {
        description:
          "Submit the PR that delivers the work. The PR URL, its description (verbatim), and a non-empty " +
          "verification claim (commands run and observed results) are required. " +
          "If the PR is already merged with green required checks the task becomes DONE; otherwise it " +
          "lands in AWAITING_MERGE (lease released) and the server promotes it to DONE when GitHub " +
          "reports merged-green. Hallucinated PR URLs are refused and the lease is kept.",
        inputSchema: {
          task_id: z.number().int(),
          summary: z.string(),
          pr_url: z.string().url().describe("URL of the PR delivering the work (open or merged)"),
          pr_description: z.string().min(20).describe("The PR's description, verbatim"),
          verification: z.string().min(1).describe("How you verified the work: commands run and observed results"),
        },
      },
      async (args) => {
        await requireCoderTask(args.task_id);
        const verification = args.verification.trim();
        if (!verification) {
          throw new Error(
            "verification is required — how you verified the work (commands run and observed results); completion refused; the task stays with you",
          );
        }
        const summary = `${args.summary}\n\nverification: ${verification}`;
        const briefNow = await queue.brief(args.task_id);
        const repo = briefNow.repo;
        const parsed = parsePrUrl(args.pr_url);
        if (!parsed) {
          throw new Error(
            `cannot parse a GitHub PR number from ${args.pr_url} — completion refused; the task stays with you`,
          );
        }
        if (repo && parsed.ownerRepo.toLowerCase() !== repo.toLowerCase()) {
          throw new Error(
            `PR ${args.pr_url} is not on project repo ${repo} — completion refused; the task stays with you`,
          );
        }
        if (!prVerifier) {
          throw new Error(
            "PR verification unavailable — configure GitHub App installation auth " +
              "(MEMRACER_GITHUB_APP_ID + MEMRACER_GITHUB_APP_PRIVATE_KEY) or MEMRACER_GITHUB_TOKEN / `gh`. " +
              "Do not infra_failure-requeue; leave the lease or release with verification-unavailable — " +
              "completion refused; the task stays with you",
          );
        }
        if (!repo) {
          throw new Error(
            `task ${args.task_id} has no project repo — cannot verify PR; completion refused; the task stays with you`,
          );
        }
        let check;
        try {
          check = await prVerifier.check(repo, parsed.number);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`${message} — completion refused; the task stays with you`);
        }
        if (check.state === "not-found") {
          throw new Error(
            `PR ${args.pr_url} not found on GitHub (${repo}#${parsed.number}) — completion refused; the task stays with you`,
          );
        }
        const terminal = check.state === "merged-green" ? "DONE" : "AWAITING_MERGE";
        const done = await queue.complete(args.task_id, leaseAgent, summary, args.pr_url, {
          prDescription: args.pr_description,
          terminal,
          prVerification: check.state,
          prVerificationEtag: check.etag,
          // Already parsed by parsePrUrl above — do not re-parse loosely in complete.
          prNumber: parsed.number,
        });
        if (terminal === "DONE") {
          await projectKnowledge.markEvent(
            done.project_id,
            ["priorities-roadmap", "architecture-tech", "history-decisions-learnings"],
            `task #${args.task_id} completed`,
          );
          await worker.enqueue(done.project_id, "reconcile", {
            taskId: args.task_id,
            agent: name,
            prUrl: args.pr_url,
            prDescription: args.pr_description,
          });
        }
        return json(await presentTaskBriefActors(db, done));
      },
    );

    server.registerTool(
      "coder_propose_plan",
      {
        description:
          "Submit your plan for a leased task. Frigg reviews and returns approved, revise(feedback), or clarify " +
          "(answer with coder_answer then re-propose). Default wait is short (~15s); if status is pending, re-call " +
          "with the SAME args. Prefer short waits (default ~15s); poll/re-enter — do not hold a main agent turn " +
          "on wait_s=90. Optional wait_s is for off-model pollers only (cap 90). Do not implement until approved. " +
          "Pending responses include instruction + next — follow them.",
        inputSchema: {
          task_id: z.number().int(),
          plan: z.string(),
          files_touched: z.array(z.string()).optional(),
          risk: z.string().optional(),
          lease_duration_ms: z.number().int().min(60_000).max(MAX_LEASE_TTL_MS).optional()
            .describe("Renew with this bounded duration while the mediator reviews the plan."),
          wait_s: z.number().int().min(1).max(90).optional()
            .describe("Seconds to block waiting for Frigg (default ~15 via MEMRACER_REVIEW_WAIT_MS). Pending → re-call same args."),
        },
      },
      async (args) => {
        await requireCoderTask(args.task_id);
        const brief = await queue.renewLease(args.task_id, leaseAgent, args.lease_duration_ms);
        const jobId = await worker.findOrEnqueue(brief.project_id, "review", {
          taskId: args.task_id, plan: args.plan, filesTouched: args.files_touched, risk: args.risk, agent: name,
        });
        const job = await worker.waitForJob(jobId, mediatorWaitMs("MEMRACER_REVIEW_WAIT_MS", args.wait_s));
        return json(jobResult(job, { loop: "plan_review" }));
      },
    );

    server.registerTool(
      "coder_answer",
      {
        description:
          "Answer Frigg's open plan-clarification for your leased task; she re-reviews with your answer. " +
          "Use when coder_propose_plan returned clarify. Same short-wait/pending re-enter rules as propose_plan.",
        inputSchema: {
          task_id: z.number().int(),
          answer: z.string(),
          wait_s: z.number().int().min(1).max(90).optional()
            .describe("Seconds to block for re-review (default ~15). Pending → re-call with same answer or re-propose."),
        },
      },
      async (args) => {
        await requireCoderTask(args.task_id);
        const brief = await queue.brief(args.task_id);
        const store = new NegotiationStore(db);
        const open = await store.openForSubject(args.task_id);
        if (!open || open.party_role !== "coder") {
          throw new Error(`no open plan clarification for task ${args.task_id}`);
        }
        if (open.state !== "awaiting_party" && open.state !== "awaiting_person") {
          throw new Error(`negotiation ${open.id} is not awaiting an answer`);
        }
        await store.answer(open.id, name, args.answer);
        const plan = brief.plan;
        if (!plan) {
          throw new Error(`task ${args.task_id} has no stored plan to re-review`);
        }
        const jobId = await worker.enqueue(brief.project_id, "review", {
          taskId: args.task_id,
          plan,
          agent: name,
          priorAnswer: args.answer,
        });
        const job = await worker.waitForJob(jobId, mediatorWaitMs("MEMRACER_REVIEW_WAIT_MS", args.wait_s));
        return json({
          rereviewed: true,
          negotiation_id: open.id,
          ...jobResult(job, { loop: "plan_rereview" }),
        });
      },
    );

    server.registerTool(
      "coder_ask",
      {
        description:
          "Ask the mediator a question about your leased task. Returns an answer, or {escalated:true} when it went " +
          "to the humans — then coder_park and pull other work. Short default wait; pending → re-call same args.",
        inputSchema: {
          task_id: z.number().int(),
          question: z.string(),
          wait_s: z.number().int().min(1).max(90).optional()
            .describe("Seconds to block for the answer (default ~15). Pending → re-call same task_id + question."),
        },
      },
      async (args) => {
        await requireCoderTask(args.task_id);
        const brief = await queue.brief(args.task_id);
        const jobId = await worker.findOrEnqueue(brief.project_id, "answer", {
          taskId: args.task_id, question: args.question, agent: name,
        });
        const job = await worker.waitForJob(jobId, mediatorWaitMs("MEMRACER_REVIEW_WAIT_MS", args.wait_s));
        return json(jobResult(job, { loop: "mediator_answer" }));
      },
    );

    const FINDING_PRIORITY: Record<"fix" | "nit" | "security", number> = {
      security: 0,
      fix: 1,
      nit: 2,
    };

    server.registerTool(
      "coder_report_finding",
      {
        description:
          "File a bug, nit, security issue, or debt noticed while working a leased task so Frigg can groom and place it. " +
          "Requires a live lease on task_id (the source task). Does not expand your plan — continue the original task. " +
          "Never silently skip findings; security-class issues always report even when fixed in-task. " +
          "Returns immediately with GROOMING + job_id (non-blocking). Optional idempotency_key dedupes retries.",
        inputSchema: {
          task_id: z.number().int().describe("Leased source task where you noticed the finding"),
          title: z.string().refine(meaningfulSubmissionText, submissionContentMessage("title")),
          body: z
            .string()
            .refine(meaningfulSubmissionText, submissionContentMessage("body"))
            .describe("What/where/why; include file:line and acceptance when known"),
          severity: z
            .enum(["fix", "nit", "security"])
            .optional()
            .describe("Severity hint: security (priority 0), fix (1), nit (2). Default fix."),
          evidence: z.array(evidenceSchema).default([]),
          idempotency_key: z.string().trim().min(1).max(200).optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        await requireCoderTask(args.task_id);
        // Live lease required — same ownership check as progress/complete.
        await queue.renewLease(args.task_id, leaseAgent);
        const source = await queue.brief(args.task_id);
        const severity = args.severity ?? "fix";
        const priority = FINDING_PRIORITY[severity];
        // Author as parent human (or lease source submitter) so clarify/questions
        // route to real humans — never treat the reporting coder agent as the human party.
        const humanAuthor = source.submitted_by || name;
        const citedBody =
          `Discovered while working task #${source.id} (reporter: ${leaseAgent}). Severity: ${severity}.\n\n` +
          args.body;
        const input = {
          title: args.title,
          body: citedBody,
          priority,
          evidence: args.evidence,
          parentId: source.id,
          // Do not preserveSubmitter as coder — ownership must stay human for clarify.
        };
        // Scope idempotency to the source task so the same key cannot cross tasks.
        const scopedKey = args.idempotency_key
          ? `finding:${source.id}:${args.idempotency_key}`
          : null;

        if (scopedKey) {
          const existingId = await queue.findSubmissionByKey(
            source.project_id,
            humanAuthor,
            scopedKey,
          );
          if (existingId !== null) {
            const existingBrief = await queue.brief(existingId);
            const existingJob = await worker.findLatestJob(source.project_id, "groom", {
              taskId: existingId,
              submittedBy: humanAuthor,
            });
            return json({
              task_id: existingId,
              // Original finding's parent — never re-stamp from a later lease.
              parent_id: existingBrief.parent_id ?? source.id,
              state:
                existingJob && ["pending", "running"].includes(existingJob.status)
                  ? "GROOMING"
                  : existingBrief.state,
              job_id: existingJob?.id ?? null,
              idempotent_replay: true,
            });
          }
        }

        const dup = await queue.findDuplicate(source.project_id, humanAuthor, args.title, citedBody);
        if (dup) {
          if (scopedKey) {
            await queue.rememberSubmissionKey(source.project_id, humanAuthor, scopedKey, dup.id);
          }
          return json({
            status: "duplicate",
            duplicate_of: dup.id,
            task_id: dup.id,
            parent_id: source.id,
            instruction: `This duplicates existing task #${dup.id} (${dup.state}); not creating a new finding.`,
          });
        }

        const submitted = scopedKey
          ? await queue.submitIdempotent(source.project_id, humanAuthor, scopedKey, input)
          : { id: await queue.submit(source.project_id, humanAuthor, input), created: true };
        const id = submitted.id;
        if (!submitted.created) {
          const existingBrief = await queue.brief(id);
          const existingJob = await worker.findLatestJob(source.project_id, "groom", {
            taskId: id,
            submittedBy: humanAuthor,
          });
          return json({
            task_id: id,
            parent_id: existingBrief.parent_id ?? source.id,
            state:
              existingJob && ["pending", "running"].includes(existingJob.status)
                ? "GROOMING"
                : existingBrief.state,
            job_id: existingJob?.id ?? null,
            idempotent_replay: true,
          });
        }
        const jobId = await worker.findOrEnqueue(source.project_id, "groom", {
          taskId: id,
          submittedBy: humanAuthor,
        });
        return json({
          task_id: id,
          parent_id: source.id,
          state: "GROOMING",
          job_id: jobId,
          idempotent_replay: false,
        });
      },
    );

    server.registerTool(
      "coder_park",
      {
        description: "Park a leased task that is waiting on a human answer. Releases the lease so you can pull other work; the task requeues when answered.",
        inputSchema: { task_id: z.number().int() },
      },
      async (args) => {
        await requireCoderTask(args.task_id);
        return json(await presentTaskBriefActors(db, await queue.park(args.task_id, leaseAgent)));
      },
    );

    server.registerTool(
      "coder_block",
      {
        description:
          "Mark a leased task blocked with a reason. Human/dependency blocks open a question and requeue on answer; infra_failure blocks auto-requeue after retry_after_ms.",
        inputSchema: {
          task_id: z.number().int(),
          reason: z.string(),
          kind: z.enum(["human", "dependency", "infra_failure"]).optional(),
          retry_after_ms: z.number().int().min(1_000).max(3_600_000).optional(),
        },
      },
      async (args) => {
        await requireCoderTask(args.task_id);
        return json(
          await presentTaskBriefActors(db, await queue.block(args.task_id, leaseAgent, args.reason, {
            kind: args.kind,
            retryAfterMs: args.retry_after_ms,
          })),
        );
      },
    );

    server.registerTool(
      "coder_release",
      {
        description:
          "Give a task back when you cannot make progress (out of depth, wrong toolchain, missing local setup) — the reason travels with the task. Requeues it immediately and releases your lease.",
        inputSchema: { task_id: z.number().int(), reason: z.string() },
      },
      async (args) => {
        await requireCoderTask(args.task_id);
        return json(
          await presentTaskBriefActors(db, await queue.release(args.task_id, leaseAgent, args.reason)),
        );
      },
    );

    server.registerTool(
      "coder_heartbeat",
      {
        description: "Off-model keepalive for supervisors and Stop hooks. Renews your active or grace-recoverable leases using each persisted duration and returns them with per-project queued depth.",
        inputSchema: {},
      },
      async () => {
        const leases = (await queue.renewAgentLeases(leaseAgent)).map((brief) => ({
          task_id: brief.id,
          project_id: brief.project_id,
          lease_expires_at: brief.lease_expires_at,
          lease_duration_ms: brief.lease_ttl_ms,
        }));
        const depths: Record<string, number> = {};
        for (const m of coderMs) {
          const row = (await db
            .prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND state='QUEUED'")
            .get<{ n: number }>(m.projectId)) as { n: number };
          depths[m.projectId] = row.n;
        }
        return json({ live_leases: leases, queued: depths });
      },
    );
  }

  return server;
}
