/**
 * Machine-readable operational disposition for nonterminal tasks.
 * Pure derivation from task facts — no DB I/O.
 */

export type DispositionKind =
  | "claimable"
  | "grooming"
  | "retrying"
  | "awaiting-human"
  | "incubating"
  | "explicitly-held"
  | "dependency-ordered"
  | "leased"
  | "blocked"
  | "verifying"
  | "terminal";

export type NextActionOwner = "coder" | "human" | "mediator" | "system" | "none";

export interface OperationalDisposition {
  disposition: DispositionKind;
  holding: boolean;
  reason: string;
  since: number | null;
  next_owner: NextActionOwner;
  retry_or_expiry: number | null;
  /** Ordering context only — never a claim gate. */
  waiting_on: number[];
}

export interface DispositionFacts {
  state: string;
  lease_agent: string | null;
  lease_expires_at: number | null;
  hold_cause: string | null;
  block_kind: string | null;
  block_requeue_at: number | null;
  incubate_until: number | null;
  grooming_rationale: string | null;
  plan: string | null;
  plan_deadline: number | null;
  queued_at: number | null;
  updated_at: number | null;
  waiting_on?: number[];
  /** Latest groom job status for this task, if any. */
  groom_job_status?: "pending" | "running" | "done" | "failed" | null;
  /** Steward escalation attempt count (0 = none). */
  steward_attempts?: number;
  has_open_question?: boolean;
}

/**
 * Derive disposition. Fail closed: unknown/impossible combinations → blocked
 * with a machine-readable reason rather than silent claimable.
 */
export function deriveOperationalDisposition(facts: DispositionFacts): OperationalDisposition {
  const waiting_on = facts.waiting_on ?? [];
  const since = facts.queued_at ?? facts.updated_at ?? null;

  if (facts.state === "DONE" || facts.state === "CLOSED") {
    return {
      disposition: "terminal",
      holding: false,
      reason: `terminal state ${facts.state}`,
      since: facts.updated_at,
      next_owner: "none",
      retry_or_expiry: null,
      waiting_on,
    };
  }

  if (facts.state === "HELD") {
    if (facts.hold_cause === "explicit") {
      return {
        disposition: "explicitly-held",
        holding: true,
        reason: "explicit hold",
        since: facts.updated_at,
        next_owner: "human",
        retry_or_expiry: null,
        waiting_on,
      };
    }
    if (facts.hold_cause === "conflict" || facts.hold_cause === "question") {
      return {
        disposition: "awaiting-human",
        holding: true,
        reason: `hold_cause=${facts.hold_cause}`,
        since: facts.updated_at,
        next_owner: "human",
        retry_or_expiry: null,
        waiting_on,
      };
    }
    return {
      disposition: "explicitly-held",
      holding: true,
      reason: facts.hold_cause ? `hold_cause=${facts.hold_cause}` : "held without cause",
      since: facts.updated_at,
      next_owner: "human",
      retry_or_expiry: null,
      waiting_on,
    };
  }

  if (facts.state === "INCUBATING") {
    return {
      disposition: "incubating",
      holding: true,
      reason: "warming period",
      since: facts.updated_at,
      next_owner: "system",
      retry_or_expiry: facts.incubate_until,
      waiting_on,
    };
  }

  if (facts.state === "BLOCKED") {
    const awaitingHuman = facts.block_kind === "human" || facts.has_open_question;
    return {
      disposition: awaitingHuman ? "awaiting-human" : "blocked",
      holding: true,
      reason: facts.block_kind ? `block_kind=${facts.block_kind}` : "blocked",
      since: facts.updated_at,
      next_owner: awaitingHuman ? "human" : "system",
      retry_or_expiry: facts.block_requeue_at,
      waiting_on,
    };
  }

  if (facts.state === "AWAITING_MERGE") {
    return {
      disposition: "verifying",
      holding: false,
      reason: "awaiting merge / PR verification",
      since: facts.updated_at,
      next_owner: "system",
      retry_or_expiry: null,
      waiting_on,
    };
  }

  if (
    (facts.state === "CLAIMED" || facts.state === "EXECUTING" || facts.state === "PLANNED") &&
    facts.lease_agent
  ) {
    return {
      disposition: "leased",
      holding: false,
      reason: `leased to ${facts.lease_agent}`,
      since: facts.updated_at,
      next_owner: "coder",
      retry_or_expiry: facts.lease_expires_at,
      waiting_on,
    };
  }

  // QUEUED / PARKED / other nonterminal unleased
  if (facts.state === "QUEUED" || facts.state === "PARKED") {
    if (facts.groom_job_status === "running" || facts.groom_job_status === "pending") {
      return {
        disposition: "grooming",
        holding: false,
        reason: `groom job ${facts.groom_job_status}`,
        since,
        next_owner: "mediator",
        retry_or_expiry: null,
        waiting_on,
      };
    }
    if (facts.groom_job_status === "failed" || (facts.steward_attempts ?? 0) > 0) {
      return {
        disposition: "retrying",
        holding: false,
        reason:
          facts.groom_job_status === "failed"
            ? "groom job failed; steward retry"
            : `steward attempts=${facts.steward_attempts}`,
        since,
        next_owner: "mediator",
        retry_or_expiry: null,
        waiting_on,
      };
    }
    // Open deps are order-only context — still claimable (never suppress).
    if (waiting_on.length > 0 && facts.grooming_rationale) {
      return {
        disposition: "claimable",
        holding: false,
        reason: "claimable; open predecessors are order hints only",
        since,
        next_owner: "coder",
        retry_or_expiry: null,
        waiting_on,
      };
    }
    if (!facts.grooming_rationale && facts.groom_job_status == null) {
      // Just submitted — may still be pre-groom or groom not yet enqueued
      return {
        disposition: "claimable",
        holding: false,
        reason: facts.grooming_rationale ? "queued and groomed" : "queued; eligible to claim or groom",
        since,
        next_owner: "coder",
        retry_or_expiry: null,
        waiting_on,
      };
    }
    return {
      disposition: "claimable",
      holding: false,
      reason: "queued and claimable",
      since,
      next_owner: "coder",
      retry_or_expiry: null,
      waiting_on,
    };
  }

  // Fail closed
  return {
    disposition: "blocked",
    holding: true,
    reason: `unrecognized or inconsistent state=${facts.state}`,
    since: facts.updated_at,
    next_owner: "system",
    retry_or_expiry: null,
    waiting_on,
  };
}
