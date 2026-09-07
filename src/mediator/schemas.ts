import { z } from "zod";
import { metaQuerySchema } from "./metaQuery.js";
import { PROJECT_KNOWLEDGE_DOMAINS, type ProjectKnowledgeDomain } from "./project-knowledge.js";

const projectKnowledgeDomainSchema = z.enum(
  PROJECT_KNOWLEDGE_DOMAINS.map((domain) => domain.id) as [ProjectKnowledgeDomain, ...ProjectKnowledgeDomain[]],
);

const projectKnowledgeQuestionSchema = z.string().trim().min(1).max(400).superRefine((question, ctx) => {
  const questionMarks = question.match(/\?/g)?.length ?? 0;
  if (questionMarks !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "refresh prompt must contain exactly one concise question" });
  }
});
const knowledgeEventsSchema = z.array(z.object({
  domain: projectKnowledgeDomainSchema,
  reason: z.string().trim().min(1).max(300),
})).max(3).optional();

export const projectKnowledgeRefreshSchema = z.object({
  checked_domains: z.array(projectKnowledgeDomainSchema).min(1).max(3),
  questions: z.array(z.object({
    domain: projectKnowledgeDomainSchema,
    trigger: z.enum(["TIME", "EVENTS", "STALENESS"]),
    question: projectKnowledgeQuestionSchema,
  })).max(3),
  rationale: z.string(),
}).superRefine((value, ctx) => {
  if (new Set(value.checked_domains).size !== value.checked_domains.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "checked domains must be unique" });
  }
  const questionDomains = value.questions.map((question) => question.domain);
  if (new Set(questionDomains).size !== questionDomains.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ask at most one refresh question per domain" });
  }
});

/** Blocking groom clarifications are one decision with an explicit recommendation. */
export const groomClarificationQuestionSchema = z.string().superRefine((question, ctx) => {
  const questionMarks = question.match(/\?/g)?.length ?? 0;
  if (questionMarks !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `groom clarification must contain exactly one question mark; got ${questionMarks}`,
    });
  }
  if (!/\bRecommended:\s*\S/.test(question)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "groom clarification must include a Recommended: answer",
    });
  }
});

export const groomSchema = z.union([
  z.object({
    action: z.literal("accept"),
    title: z.string(),
    body: z.string(),
    priority: z.number().int().min(0).max(3),
    rationale: z.string(),
    depends_on: z.array(z.number().int()).optional(),
    project_questions: z.array(z.string()).max(3).optional(),
    knowledge_events: knowledgeEventsSchema,
    extraction: z.object({
      subject: z.string().min(1),
      current_behavior: z.string(),
      desired_behavior: z.string(),
      in_scope: z.array(z.string()),
      out_of_scope: z.array(z.string()),
    }).optional(),
  }),
  z.object({ action: z.literal("merge"), into_task_id: z.number().int(), rationale: z.string(), project_questions: z.array(z.string()).max(3).optional(), knowledge_events: knowledgeEventsSchema }),
  z.object({ action: z.literal("refuse"), rationale: z.string(), knowledge_events: knowledgeEventsSchema }),
  z.object({
    action: z.literal("clarify"),
    question: groomClarificationQuestionSchema,
    rationale: z.string(),
    /** Optional; absent values are normalized via personOwnedFromClarify. */
    person_owned: z.boolean().optional(),
    project_questions: z.array(z.string()).max(3).optional(),
    knowledge_events: knowledgeEventsSchema,
  }),
]);

/**
 * Fresh-context faithfulness verdict (FACTS-Grounding phase-1): does the
 * groomed brief serve the SAME request as the submission? Binary, with a reason.
 */
export const eligibilitySchema = z.object({
  serves_request: z.boolean(),
  reason: z.string(),
});

export const enhanceSchema = z.union([
  z.object({ action: z.literal("merge"), body: z.string(), rationale: z.string() }),
  z.object({ action: z.literal("refuse"), rationale: z.string() }),
  z.object({ action: z.literal("clarify"), question: z.string(), rationale: z.string() }),
]);

export const reviewSchema = z.object({
  // clarify: multi-round interrogation before accept (task #420). feedback is
  // the open question when verdict is clarify; unused empty string is fine for approve.
  verdict: z.enum(["approved", "revise", "clarify"]),
  feedback: z.string(),
  rationale: z.string(),
});

const queueActionSchema = z.union([
  z.object({ action: z.literal("close_task"), task_id: z.number().int(), reason: z.string() }),
  z.object({
    action: z.literal("set_priority"),
    task_id: z.number().int(),
    priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    reason: z.string(),
  }),
  z.object({
    action: z.literal("update_task"),
    task_id: z.number().int(),
    title: z.string().optional(),
    body: z.string().optional(),
    reason: z.string(),
  }),
  z.object({
    action: z.literal("add_dependency"),
    dependent_task_id: z.number().int(),
    depends_on_task_id: z.number().int(),
    reason: z.string(),
  }),
  z.object({
    action: z.literal("remove_dependency"),
    dependent_task_id: z.number().int(),
    depends_on_task_id: z.number().int(),
    reason: z.string(),
  }),
  z.object({ action: z.literal("hold"), task_id: z.number().int(), reason: z.string() }),
  z.object({ action: z.literal("reopen"), task_id: z.number().int(), reason: z.string() }),
  z.object({ action: z.literal("rescind_memory"), path: z.string(), reason: z.string() }),
]);

export const conciliateSchema = z.object({
  settled: z.boolean(),
  summary: z.string(),
  actions: z.array(queueActionSchema).max(5),
  rationale: z.string(),
});

export const discussSchema = z.object({
  reply: z.string(),
  actions: z.array(queueActionSchema).max(5),
  rationale: z.string(),
  // Escape hatch (C9): an optional bounded read-only query the historian may
  // request when the fixed packs miss. The whitelist schema refuses raw SQL.
  query: metaQuerySchema.optional(),
});

/**
 * A shareable reference to a project entity, minted server-side and attached to
 * mediator replies and persisted decision claims. Never model-authored: the server derives it from an
 * id the mediator cited inline and post-validates the id against project state
 * before minting the URL (Anthropic Citations pattern).
 */
export const referenceSchema = z.object({
  type: z.enum(["task", "thread", "decision", "evidence", "pr"]),
  id: z.number().int(),
  url: z.string(),
  label: z.string(),
});

export const answerSchema = z.union([
  z.object({
    escalate: z.literal(false),
    answer: z.string(),
    actions: z.array(queueActionSchema).max(3).optional(),
    rationale: z.string(),
  }),
  z.object({ escalate: z.literal(true), rationale: z.string() }),
]);

export type Reference = z.infer<typeof referenceSchema>;
