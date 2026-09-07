import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskPrStatus } from "../src/dashboard/web/components/task-pr-status.js";
import { ActorLabel, Avatar, IdentityChip, actorDisplayName, actorRoleDisplayName } from "../src/dashboard/web/components/ui/avatar.js";
import { Badge, stateTone, StatusBadge } from "../src/dashboard/web/components/ui/badge.js";
import { Button } from "../src/dashboard/web/components/ui/button.js";
import { Card, SidebarSection } from "../src/dashboard/web/components/ui/card.js";
import { EmptyState, ErrorState, LoadingState, resolveQueryView } from "../src/dashboard/web/components/ui/state.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../src/dashboard/web/components/ui/table.js";
import type { CompletedTaskDto } from "../src/dashboard/web/data/dto.js";

/** Mirrors CompletedTableRow markup for static tests (archive is dialog-bound). */
function CompletedArchiveRowPreview({ task }: { task: CompletedTaskDto }) {
  return (
    <tr className="completed-row">
      <td>
        <span className="completed-row-task">
          <b>{task.title.trim() || "untitled"}</b>
          <span>#{task.id}</span>
        </span>
        <TaskPrStatus
          resultPrUrl={task.result_pr_url}
          resultPrNumber={task.result_pr_number}
          prVerification={task.pr_verification}
        />
      </td>
    </tr>
  );
}

describe("dashboard UI primitives", () => {
  it("surfaces PR link and chips on completed/archive task rows", () => {
    const task: CompletedTaskDto = {
      id: 486,
      title: "Clear transient probe stamp",
      state: "DONE",
      submitted_by: "andrew",
      updated_at: Date.now(),
      result_pr_url: "https://github.com/recallnet/memracer/pull/329",
      result_pr_number: 329,
      pr_verification: "merged-green",
    };
    const html = renderToStaticMarkup(<CompletedArchiveRowPreview task={task} />);
    expect(html).toContain('href="https://github.com/recallnet/memracer/pull/329"');
    expect(html).toContain("PR #329");
    expect(html).toContain('data-pr-merge="Merged"');
    expect(html).toContain('data-pr-ci="Green"');
    expect(html).toContain("Clear transient probe stamp");

    const noPr = renderToStaticMarkup(
      <CompletedArchiveRowPreview
        task={{ ...task, result_pr_url: null, result_pr_number: null, pr_verification: null }}
      />,
    );
    expect(noPr).not.toContain("task-pr-status");
    expect(noPr).not.toContain("href=");
  });

  it("renders clickable PR link with merge and CI chips from pr_verification", () => {
    const openPending = renderToStaticMarkup(
      <TaskPrStatus
        resultPrUrl="https://github.com/recallnet/memracer/pull/323"
        resultPrNumber={323}
        prVerification="checks-pending"
      />,
    );
    expect(openPending).toContain('href="https://github.com/recallnet/memracer/pull/323"');
    expect(openPending).toContain("PR #323");
    expect(openPending).toContain('target="_blank"');
    expect(openPending).toContain("noopener");
    expect(openPending).toContain('data-pr-merge="Open"');
    expect(openPending).toContain(">Open<");
    expect(openPending).toContain('data-pr-ci="Pending"');
    expect(openPending).toContain(">Pending<");

    const merged = renderToStaticMarkup(
      <TaskPrStatus
        resultPrUrl="https://github.com/recallnet/memracer/pull/300"
        resultPrNumber={300}
        prVerification="merged-green"
      />,
    );
    expect(merged).toContain('data-pr-merge="Merged"');
    expect(merged).toContain('data-pr-ci="Green"');
    expect(merged).toContain(">Merged<");
    expect(merged).toContain(">Green<");

    const closed = renderToStaticMarkup(
      <TaskPrStatus
        resultPrUrl="https://github.com/recallnet/memracer/pull/310"
        resultPrNumber={310}
        prVerification="closed-unmerged"
      />,
    );
    expect(closed).toContain('data-pr-merge="Closed-unmerged"');
    expect(closed).toContain(">Closed-unmerged<");
    expect(closed).not.toContain("data-pr-ci=");

    const gone = renderToStaticMarkup(
      <TaskPrStatus
        resultPrUrl="https://github.com/recallnet/memracer/pull/999"
        resultPrNumber={999}
        prVerification="not-found"
      />,
    );
    expect(gone).toContain('href="https://github.com/recallnet/memracer/pull/999"');
    expect(gone).toContain('data-pr-merge="Gone"');
    expect(gone).toContain(">Gone<");
    expect(gone).not.toContain("data-pr-ci=");

    expect(renderToStaticMarkup(
      <TaskPrStatus resultPrUrl={null} resultPrNumber={1} prVerification="open" />,
    )).toBe("");
  });

  it("prioritizes an error when a failed query also has no rows", () => {
    expect(resolveQueryView({ error: true, pending: false, empty: true })).toBe("error");
  });

  it("resolves the remaining query states in precedence order", () => {
    expect(resolveQueryView({ error: false, pending: true, empty: true })).toBe("loading");
    expect(resolveQueryView({ error: false, pending: false, empty: true })).toBe("empty");
    expect(resolveQueryView({ error: false, pending: false, empty: false })).toBe("ready");
  });

  it("maps every task lifecycle state to an explicit status tone", () => {
    expect(Object.keys(stateTone)).toEqual(expect.arrayContaining([
      "INCUBATING", "QUEUED", "HELD", "CLAIMED", "PLANNED", "EXECUTING",
      "BLOCKED", "PARKED", "DONE", "REVIEW", "VERIFY", "MERGED", "ACCEPTED",
    ]));
    expect(renderToStaticMarkup(<StatusBadge state="EXECUTING" />)).toContain('data-tone="executing"');
  });

  it("projects every mediator attribution to Frigg", () => {
    expect(actorDisplayName("steward", "mediator")).toBe("Frigg");
    expect(actorDisplayName("mediator", "mediator")).toBe("Frigg");
    expect(actorDisplayName("Legacy Name", "human")).toBe("Legacy Name");
    expect(actorRoleDisplayName("mediator")).toBe("Frigg");
    const markup = renderToStaticMarkup(<>
      <Avatar name="steward" role="mediator" />
      <IdentityChip name="mediator" role="mediator" />
      <ActorLabel name="steward" role="mediator" />
    </>);
    expect(markup).toContain('data-identity-key="agent:frigg"');
    expect(markup).toContain('data-actor-role="mediator"');
    expect(markup).toContain('<span class="actor-role">Frigg</span>');
    expect(markup).toContain('aria-label="Frigg"');
    expect(markup.match(/<b>Frigg<\/b>/g)).toHaveLength(2);
    expect(markup).not.toContain("steward");
    expect(markup).not.toContain(">mediator<");
  });

  it("renders semantic controls, states, identity, cards, and tables", () => {
    const markup = renderToStaticMarkup(<>
      <Button variant="primary">Create</Button><Badge variant="warning">queued</Badge>
      <LoadingState label="Loading" /><EmptyState label="Empty" /><ErrorState label="Failed" />
      <Avatar name="Ada" role="human" /><IdentityChip name="coder-1" role="coder" />
      <Card><SidebarSection>Section</SidebarSection></Card>
      <Table><TableHeader><TableRow><TableHead>Task</TableHead></TableRow></TableHeader><TableBody><TableRow><TableCell>#220</TableCell></TableRow></TableBody></Table>
    </>);
    expect(markup).toContain("ui-button");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-actor-role="coder"');
    expect(markup).toContain("<table");
  });
});
