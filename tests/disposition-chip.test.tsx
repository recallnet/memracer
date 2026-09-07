import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QueueTaskDto } from "../src/dashboard/web/data/dto.js";
import { displayDisposition, liveConnectionLabel } from "../src/dashboard/web/lib/home-model.js";

function DispositionChip({ task }: { task: QueueTaskDto }) {
  const op = task.operational;
  if (!op || op.disposition === "terminal") return null;
  return (
    <span
      className={`disposition-chip${op.holding ? " is-holding" : ""}`}
      data-disposition={op.disposition}
      data-testid="disposition-chip"
      title={op.reason}
    >
      {displayDisposition(op.disposition)}
    </span>
  );
}

const base: QueueTaskDto = {
  id: 1,
  title: "t",
  body: "",
  priority: 0,
  state: "QUEUED",
  base_sha: null,
  repo: null,
  submitted_by: "ada",
  lease_agent: null,
  lease_expires_at: null,
  result_summary: null,
  result_pr_url: null,
  result_pr_number: null,
  pr_verification: null,
  grooming_rationale: "ok",
  parent_id: null,
  incubate_until: null,
  hold_cause: null,
  created_at: 1,
  updated_at: 1,
  evidence_count: 0,
  latest_attempt_note: null,
};

describe("disposition chip (held vs claimable)", () => {
  it("renders human labels and keeps machine data-disposition", () => {
    const claimable = renderToStaticMarkup(
      <DispositionChip
        task={{
          ...base,
          operational: {
            disposition: "claimable",
            holding: false,
            reason: "queued",
            since: 1,
            next_owner: "coder",
            retry_or_expiry: null,
            waiting_on: [],
          },
        }}
      />,
    );
    const held = renderToStaticMarkup(
      <DispositionChip
        task={{
          ...base,
          state: "HELD",
          hold_cause: "explicit",
          operational: {
            disposition: "explicitly-held",
            holding: true,
            reason: "explicit hold",
            since: 1,
            next_owner: "human",
            retry_or_expiry: null,
            waiting_on: [],
          },
        }}
      />,
    );
    expect(claimable).toContain('data-disposition="claimable"');
    expect(claimable).toContain("Claimable");
    expect(claimable).not.toMatch(/>claimable</);
    expect(claimable).not.toContain("is-holding");
    expect(held).toContain('data-disposition="explicitly-held"');
    expect(held).toContain("Held");
    expect(held).toContain("is-holding");
    expect(claimable).not.toBe(held);
  });
});

describe("displayDisposition / liveConnectionLabel", () => {
  it("humanizes every known disposition", () => {
    expect(displayDisposition("awaiting-human")).toBe("Awaiting human");
    expect(displayDisposition("dependency-ordered")).toBe("Waiting on dependency");
    expect(displayDisposition("leased")).toBe("Leased");
  });

  it("uses the same connection labels on mobile and desktop", () => {
    expect(liveConnectionLabel("live")).toBe("Connected");
    expect(liveConnectionLabel("connecting")).toBe("Connected");
    expect(liveConnectionLabel("reconnecting")).toBe("Retrying");
    expect(liveConnectionLabel("offline")).toBe("Offline");
    expect(liveConnectionLabel("unavailable")).toBe("Unavailable");
  });
});
