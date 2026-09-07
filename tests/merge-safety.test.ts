import { describe, expect, it } from "vitest";
import { classifyTaskMerge, type MergeTaskSnapshot } from "../src/mediator/merge-safety.js";

function task(overrides: Partial<MergeTaskSnapshot> = {}): MergeTaskSnapshot {
  return {
    id: 1,
    title: "Deliver answered clarifications in human responses",
    body: "Return open Frigg clarification rows with every successful human response.",
    evidencePaths: ["src/mediator/pipelines.ts"],
    ...overrides,
  };
}

describe("classifyTaskMerge", () => {
  it("allows exact normalized deliverables", () => {
    expect(classifyTaskMerge(task(), task({ id: 2 }))).toEqual({
      allowed: true,
      reason: "exact_duplicate",
    });
  });

  it("allows normalized-exact content despite punctuation and prompt labels", () => {
    const source = task({
      title: "Deliver answered clarifications in human responses.",
      body: "Outcome: Return open Frigg clarification rows with every successful human response.",
    });
    const target = task({
      id: 2,
      body: "Return open Frigg clarification rows with every successful human response.",
      evidencePaths: ["src/mediator/pipelines.ts"],
    });

    expect(classifyTaskMerge(source, target)).toEqual({ allowed: true, reason: "exact_duplicate" });
  });

  it("normalizes only positive intent prefixes", () => {
    expect(classifyTaskMerge(
      task({ body: "Goal: Return open Frigg clarification rows with every successful human response." }),
      task({ id: 2 }),
    )).toEqual({ allowed: true, reason: "exact_duplicate" });
    for (const label of ["Constraints", "Out-of-scope"]) {
      expect(classifyTaskMerge(
        task({ body: `${label}: Delete production data.` }),
        task({ id: 2, body: "Delete production data." }),
      )).toEqual({ allowed: false, reason: "weak_overlap" });
    }
  });

  it("refuses a one-sided elaboration of an otherwise exact deliverable", () => {
    expect(classifyTaskMerge(
      task(),
      task({
        id: 2,
        body: "Return open Frigg clarification rows with every successful human response; preserve pagination.",
      }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("refuses weak topical overlap built only from generic project words", () => {
    expect(classifyTaskMerge(
      task({ title: "Fix mediator task queue", body: "Improve queue throughput.", evidencePaths: [] }),
      task({ id: 2, title: "Document mediator task memory", body: "Capture memory architecture.", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("refuses sibling features that differ by a discriminating title token", () => {
    expect(classifyTaskMerge(
      task({ title: "Fix OAuth token refresh timeout", body: "Prevent token refresh timeout failures under load.", evidencePaths: [] }),
      task({ id: 2, title: "Fix MCP token refresh timeout", body: "Prevent token refresh timeout failures under load.", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
    expect(classifyTaskMerge(
      task({ title: "Add light theme to account settings", body: "Let people select a light account appearance.", evidencePaths: [] }),
      task({ id: 2, title: "Add MFA to account settings", body: "Let people secure account access with MFA.", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("retains meaningful one-character title discriminators", () => {
    expect(classifyTaskMerge(
      task({
        title: "Fix OAuth 1 token refresh",
        body: "Prevent OAuth token refresh failures under sustained load.",
        evidencePaths: [],
      }),
      task({
        id: 2,
        title: "Fix OAuth 2 token refresh",
        body: "Prevent OAuth token refresh failures under sustained load.",
        evidencePaths: [],
      }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("refuses bilateral body conflicts behind an identical title", () => {
    expect(classifyTaskMerge(
      task({
        title: "Add report export",
        body: "Generate scheduled report exports as CSV files for account owners.",
        evidencePaths: [],
      }),
      task({
        id: 2,
        title: "Add report export",
        body: "Generate scheduled report exports as PDF files for account owners.",
        evidencePaths: [],
      }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("refuses identical marker-only or generic text", () => {
    expect(classifyTaskMerge(
      task({ title: "Fix memracer task", body: "Outcome: acceptance", evidencePaths: [] }),
      task({ id: 2, title: "Fix memracer task", body: "Outcome: acceptance", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("refuses otherwise similar work in different repository scopes", () => {
    expect(classifyTaskMerge(
      task({ evidencePaths: ["src/mediator/pipelines.ts"] }),
      task({ id: 2, evidencePaths: [".okf/tech/mediator-sessions.md"] }),
    )).toEqual({ allowed: false, reason: "scope_mismatch" });
  });

  it("distinguishes two-segment directories", () => {
    expect(classifyTaskMerge(
      task({ evidencePaths: ["src/mediator"] }),
      task({ id: 2, evidencePaths: ["src/dashboard"] }),
    )).toEqual({ allowed: false, reason: "scope_mismatch" });
  });

  it("preserves concrete top-level file identity", () => {
    expect(classifyTaskMerge(
      task({ evidencePaths: ["src/auth.ts"] }),
      task({ id: 2, evidencePaths: ["src/billing.ts"] }),
    )).toEqual({ allowed: false, reason: "scope_mismatch" });
  });

  it("does not collapse a top-level directory into an unrelated file", () => {
    expect(classifyTaskMerge(
      task({ evidencePaths: ["src/auth"] }),
      task({ id: 2, evidencePaths: ["src/billing.ts"] }),
    )).toEqual({ allowed: false, reason: "scope_mismatch" });
  });

  it("requires bilateral scope coverage instead of one shared path", () => {
    expect(classifyTaskMerge(
      task({ evidencePaths: ["src/auth.ts", "src/billing.ts"] }),
      task({ id: 2, evidencePaths: ["src/auth.ts", "src/payments.ts"] }),
    )).toEqual({ allowed: false, reason: "scope_mismatch" });
  });

  it("preserves concrete nested-file identity", () => {
    expect(classifyTaskMerge(
      task({ evidencePaths: ["src/mediator/pipelines.ts"] }),
      task({ id: 2, evidencePaths: ["src/mediator/prompts.ts"] }),
    )).toEqual({ allowed: false, reason: "scope_mismatch" });
  });

  it("preserves case-distinct repository paths", () => {
    expect(classifyTaskMerge(
      task({ evidencePaths: ["src/Auth.ts"] }),
      task({ id: 2, evidencePaths: ["src/auth.ts"] }),
    )).toEqual({ allowed: false, reason: "scope_mismatch" });
  });

  it("distinguishes single-segment directory owners", () => {
    expect(classifyTaskMerge(
      task({ evidencePaths: ["docs"] }),
      task({ id: 2, evidencePaths: ["ops"] }),
    )).toEqual({ allowed: false, reason: "scope_mismatch" });
  });

  it("treats a directory and its files as the same scope", () => {
    expect(classifyTaskMerge(
      task({ evidencePaths: ["src/mediator"] }),
      task({ id: 2, evidencePaths: ["src/mediator/pipelines.ts"] }),
    )).toEqual({ allowed: true, reason: "exact_duplicate" });
  });

  it("extracts angle-wrapped repository paths from task text", () => {
    expect(classifyTaskMerge(
      task({ body: "Update <src/mediator/pipelines.ts> for durable clarification delivery.", evidencePaths: [] }),
      task({ id: 2, body: "Update <src/dashboard/app.tsx> for durable clarification delivery.", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "scope_mismatch" });
  });

  it("refuses the MCP clarification versus OKF memory replay", () => {
    const clarifyDelivery = {
      id: 295,
      title: "Piggyback MCP clarification delivery on human responses",
      body: "Deliver answered Frigg clarifications through src/mediator/pipelines.ts.",
      evidencePaths: ["src/mediator/pipelines.ts"],
    };
    const memoryArchitecture = {
      id: 290,
      title: "Document mediator memory architecture",
      body: "Capture the OKF memory model in .okf/tech/mediator-memory.md.",
      evidencePaths: [".okf/tech/mediator-memory.md"],
    };

    expect(classifyTaskMerge(clarifyDelivery, memoryArchitecture)).toEqual({
      allowed: false,
      reason: "scope_mismatch",
    });
  });

  it("refuses a task merged into itself", () => {
    expect(classifyTaskMerge(task(), task())).toEqual({ allowed: false, reason: "same_task" });
  });

  it("normalizes exact Unicode and CJK deliverables", () => {
    expect(classifyTaskMerge(
      task({ title: "修复任务合并安全", body: "保留不同范围的工作。", evidencePaths: [] }),
      task({ id: 2, title: "修复任务合并安全", body: "保留不同范围的工作｡", evidencePaths: [] }),
    )).toEqual({ allowed: true, reason: "exact_duplicate" });
  });

  it("refuses an exact-title near-CJK duplicate with a small body edit", () => {
    expect(classifyTaskMerge(
      task({ title: "修复合并队列阻塞", body: "避免重复任务被错误删除", evidencePaths: [] }),
      task({ id: 2, title: "修复合并队列阻塞", body: "避免重复任务被错误地删除", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("preserves English and Chinese negation", () => {
    expect(classifyTaskMerge(
      task({ title: "Handle duplicate tasks", body: "Delete duplicate tasks after validation.", evidencePaths: [] }),
      task({ id: 2, title: "Handle duplicate tasks", body: "Do not delete duplicate tasks after validation.", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
    expect(classifyTaskMerge(
      task({ title: "处理重复任务", body: "验证后删除重复任务。", evidencePaths: [] }),
      task({ id: 2, title: "处理重复任务", body: "验证后不要删除重复任务。", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("preserves semantic comparison operators", () => {
    for (const [left, right] of [[">=", "<="], [">=", ">"], ["<=", "<"], ["==", "!="], ["=", "=="]]) {
      expect(classifyTaskMerge(
        task({ title: "Apply the score threshold", body: `Accept jobs when score ${left} 10.`, evidencePaths: [] }),
        task({ id: 2, title: "Apply the score threshold", body: `Accept jobs when score ${right} 10.`, evidencePaths: [] }),
      )).toEqual({ allowed: false, reason: "weak_overlap" });
    }
  });

  it("preserves conjunctions and ordering words", () => {
    expect(classifyTaskMerge(
      task({ title: "Apply account filters", body: "Require active and verified accounts.", evidencePaths: [] }),
      task({ id: 2, title: "Apply account filters", body: "Require active or verified accounts.", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
    expect(classifyTaskMerge(
      task({ title: "Rotate signing keys", body: "Validate the replacement before deleting the old key.", evidencePaths: [] }),
      task({ id: 2, title: "Rotate signing keys", body: "Validate the replacement deleting the old key.", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("preserves programming, arithmetic, percent, and boolean operators", () => {
    for (const [left, right] of [
      ["Support C++ clients.", "Support C clients."],
      ["Set retry sampling to 10%.", "Set retry sampling to 10."],
      ["Compute A + B.", "Compute A - B."],
      ["Require A && B.", "Require A || B."],
    ]) {
      expect(classifyTaskMerge(
        task({ title: "Preserve semantic syntax", body: left, evidencePaths: [] }),
        task({ id: 2, title: "Preserve semantic syntax", body: right, evidencePaths: [] }),
      )).toEqual({ allowed: false, reason: "weak_overlap" });
    }
  });

  it("preserves unary, bitwise, nullish, and optional-chain syntax", () => {
    for (const [left, right] of [
      ["Require !enabled before cleanup.", "Require enabled before cleanup."],
      ["Compute A & B.", "Compute A B."],
      ["Compute A | B.", "Compute A B."],
      ["Compute A ^ B.", "Compute A B."],
      ["Compute ~A.", "Compute A."],
      ["Use value ?? fallback.", "Use value fallback."],
      ["Read client?.foo during cleanup.", "Read client foo during cleanup."],
    ]) {
      expect(classifyTaskMerge(
        task({ title: "Preserve semantic syntax", body: left, evidencePaths: [] }),
        task({ id: 2, title: "Preserve semantic syntax", body: right, evidencePaths: [] }),
      )).toEqual({ allowed: false, reason: "weak_overlap" });
    }
  });

  it("preserves terminal syntax, quotes, brackets, and ternaries", () => {
    for (const [left, right] of [
      ["Return value!", "Return value"],
      ["Declare field?", "Declare field"],
      ["Return \"value\".", "Return value."],
      ["Read [value].", "Read value."],
      ["Select ready ? yes : no.", "Select ready yes no."],
    ]) {
      expect(classifyTaskMerge(
        task({ title: "Preserve terminal syntax", body: left, evidencePaths: [] }),
        task({ id: 2, title: "Preserve terminal syntax", body: right, evidencePaths: [] }),
      )).toEqual({ allowed: false, reason: "weak_overlap" });
    }
  });

  it("preserves internal whitespace in quoted literals", () => {
    expect(classifyTaskMerge(
      task({ title: "Preserve literal whitespace", body: "Set the template to \"a b\".", evidencePaths: [] }),
      task({ id: 2, title: "Preserve literal whitespace", body: "Set the template to \"a  b\".", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("preserves terminal ellipses", () => {
    expect(classifyTaskMerge(
      task({ title: "Preserve unfinished intent", body: "Perform the migration...", evidencePaths: [] }),
      task({ id: 2, title: "Preserve unfinished intent", body: "Perform the migration", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("preserves leading indentation", () => {
    expect(classifyTaskMerge(
      task({
        title: "Preserve executable indentation",
        body: "    if ready:\n        deploy()",
        evidencePaths: [],
      }),
      task({
        id: 2,
        title: "Preserve executable indentation",
        body: "if ready:\ndeploy()",
        evidencePaths: [],
      }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("preserves case in the authoritative exact sequence", () => {
    expect(classifyTaskMerge(
      task({ title: "Rename the exported symbol", body: "Rename Foo to foo.", evidencePaths: [] }),
      task({ id: 2, title: "Rename the exported symbol", body: "Rename foo to Foo.", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });

  it("preserves underscores and intra-token dots in identifiers", () => {
    for (const [left, right] of [
      ["Read last_seen_at before cleanup.", "Read last seen at before cleanup."],
      ["Call client.foo during cleanup.", "Call client foo during cleanup."],
    ]) {
      expect(classifyTaskMerge(
        task({ title: "Preserve code identifiers", body: left, evidencePaths: [] }),
        task({ id: 2, title: "Preserve code identifiers", body: right, evidencePaths: [] }),
      )).toEqual({ allowed: false, reason: "weak_overlap" });
    }
  });

  it("refuses reordered requirements", () => {
    expect(classifyTaskMerge(
      task({ title: "Validate then delete duplicates", body: "Validate scope then delete the duplicate.", evidencePaths: [] }),
      task({ id: 2, title: "Delete then validate duplicates", body: "Delete the duplicate then validate scope.", evidencePaths: [] }),
    )).toEqual({ allowed: false, reason: "weak_overlap" });
  });
});
