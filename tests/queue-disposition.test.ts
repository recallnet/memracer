import { describe, expect, it } from "vitest";
import {
  deriveOperationalDisposition,
  type DispositionFacts,
} from "../src/operational-disposition.js";

function facts(partial: Partial<DispositionFacts> = {}): DispositionFacts {
  return {
    state: "QUEUED",
    lease_agent: null,
    lease_expires_at: null,
    hold_cause: null,
    block_kind: null,
    block_requeue_at: null,
    incubate_until: null,
    grooming_rationale: "groomed",
    plan: null,
    plan_deadline: null,
    queued_at: 1_000,
    updated_at: 1_000,
    waiting_on: [],
    groom_job_status: null,
    steward_attempts: 0,
    has_open_question: false,
    ...partial,
  };
}

describe("deriveOperationalDisposition", () => {
  it("reports claimable for unleased QUEUED even with open ordering deps (#572-style)", () => {
    const d = deriveOperationalDisposition(
      facts({ waiting_on: [99, 100], grooming_rationale: "ok" }),
    );
    expect(d.disposition).toBe("claimable");
    expect(d.holding).toBe(false);
    expect(d.waiting_on).toEqual([99, 100]);
    expect(d.next_owner).toBe("coder");
  });

  it("reports grooming when groom job is running", () => {
    const d = deriveOperationalDisposition(facts({ groom_job_status: "running", grooming_rationale: null }));
    expect(d.disposition).toBe("grooming");
    expect(d.next_owner).toBe("mediator");
  });

  it("reports retrying when groom failed", () => {
    const d = deriveOperationalDisposition(facts({ groom_job_status: "failed" }));
    expect(d.disposition).toBe("retrying");
  });

  it("reports explicitly-held for HELD+explicit and holds claims", () => {
    const d = deriveOperationalDisposition(
      facts({ state: "HELD", hold_cause: "explicit", grooming_rationale: null }),
    );
    expect(d.disposition).toBe("explicitly-held");
    expect(d.holding).toBe(true);
    expect(d.next_owner).toBe("human");
  });

  it("reports leased when lease_agent set", () => {
    const d = deriveOperationalDisposition(
      facts({ state: "EXECUTING", lease_agent: "coder-1", lease_expires_at: 9_000 }),
    );
    expect(d.disposition).toBe("leased");
    expect(d.retry_or_expiry).toBe(9_000);
  });

  it("reports incubating with expiry", () => {
    const d = deriveOperationalDisposition(
      facts({ state: "INCUBATING", incubate_until: 5_000, grooming_rationale: null }),
    );
    expect(d.disposition).toBe("incubating");
    expect(d.holding).toBe(true);
    expect(d.retry_or_expiry).toBe(5_000);
  });

  it("reports verifying for AWAITING_MERGE", () => {
    expect(deriveOperationalDisposition(facts({ state: "AWAITING_MERGE" })).disposition).toBe(
      "verifying",
    );
  });

  it("fails closed on unknown state", () => {
    const d = deriveOperationalDisposition(facts({ state: "WEIRD" }));
    expect(d.disposition).toBe("blocked");
    expect(d.holding).toBe(true);
    expect(d.reason).toMatch(/unrecognized/i);
  });

  it("distinguishes grooming-in-flight vs claimable for ambiguous QUEUED snapshot", () => {
    const grooming = deriveOperationalDisposition(
      facts({ grooming_rationale: null, groom_job_status: "pending" }),
    );
    const claimable = deriveOperationalDisposition(
      facts({ grooming_rationale: "done", groom_job_status: "done" }),
    );
    expect(grooming.disposition).toBe("grooming");
    expect(claimable.disposition).toBe("claimable");
    expect(grooming.disposition).not.toBe(claimable.disposition);
  });
});
