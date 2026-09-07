import { describe, expect, it } from "vitest";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorContext } from "../src/mediator/driver.js";

const ctx: MediatorContext = { projectId: "p", projectName: "P", queue: [], decisions: [], memory: "" };
const reviewTask = { title: "task", body: "plain task", groomingRationale: "accepted as submitted" };

describe("FakeDriver", () => {
  it("grooms: accept, merge, clarify", async () => {
    const d = new FakeDriver();
    expect(
      await d.groom(ctx, { taskId: 1, title: "t", body: "plain", priority: 2, submittedBy: "dana", evidence: [] }),
    ).toMatchObject({ action: "accept", title: "t", body: "plain", priority: 2, rationale: "accepted as submitted" });
    expect(
      await d.groom(ctx, { taskId: 2, title: "t", body: "MERGE:7 same thing", priority: 2, submittedBy: "dana", evidence: [] }),
    ).toMatchObject({ action: "merge", into_task_id: 7, rationale: "duplicate of task 7" });
    expect(
      await d.groom(ctx, {
        taskId: 3,
        title: "t",
        body: "CLARIFY: Which endpoint should expose it? Recommended: /api/tasks — it matches the existing resource.",
        priority: 2,
        submittedBy: "dana",
        evidence: [],
      }),
    ).toMatchObject({
      action: "clarify",
      question: "Which endpoint should expose it? Recommended: /api/tasks — it matches the existing resource.",
      rationale: "submission is ambiguous",
    });
  });

  it("rejects a malformed CLARIFY marker instead of emitting an invalid groom result", async () => {
    const d = new FakeDriver();
    await expect(
      d.groom(ctx, {
        taskId: 4,
        title: "t",
        body: "CLARIFY: which endpoint?",
        priority: 2,
        submittedBy: "dana",
        evidence: [],
      }),
    ).rejects.toThrow(/Recommended:/i);
  });

  it("CLARIFY-OWNED: returns person_owned true for e2e human-decision paths", async () => {
    const d = new FakeDriver();
    // Schema still requires Recommended:; person_owned:true overrides ownership.
    expect(
      await d.groom(ctx, {
        taskId: 5,
        title: "t",
        body: "CLARIFY-OWNED: Ship v1 now or wait for v2 scope? Recommended: ship v1 — keeps the release train moving.",
        priority: 2,
        submittedBy: "dana",
        evidence: [],
      }),
    ).toMatchObject({
      action: "clarify",
      question:
        "Ship v1 now or wait for v2 scope? Recommended: ship v1 — keeps the release train moving.",
      person_owned: true,
    });
  });

  it("grooms FEATURE: submissions without research by self-serving factual choices", async () => {
    const d = new FakeDriver();
    const gated = await d.groom(ctx, {
      taskId: 4, title: "Add realtime collab", body: "FEATURE: add realtime collaborative editing",
      priority: 2, submittedBy: "dana", evidence: [],
    });
    expect(gated.action).toBe("accept");
    if (gated.action === "accept") {
      expect(gated.body).toMatch(/self-serve factual implementation choices/i);
      expect(gated.rationale).toMatch(/self-served/i);
    }
  });

  it("grooms FEATURE: submissions with research evidence into an ordered-fields brief", async () => {
    const d = new FakeDriver();
    const accepted = await d.groom(ctx, {
      taskId: 5, title: "Add realtime collab", body: "FEATURE: add realtime collaborative editing",
      priority: 2, submittedBy: "dana",
      evidence: [{ kind: "research", note: "compared yjs vs automerge; yjs wins on ecosystem" }],
    });
    expect(accepted.action).toBe("accept");
    if (accepted.action === "accept") {
      for (const f of ["Outcome", "Evidence", "Pointers", "Acceptance criteria", "Verification", "Out-of-scope", "Constraints"]) {
        expect(accepted.body).toContain(f);
      }
    }
  });

  it.each([
    [101, "Throttle abusive clients", "Cap request rates on the public REST API and return 429.", "Add rate limiting to public REST API"],
    [103, "Uploads fail with gateway errors", "Large file uploads intermittently return 502s.", "Fix intermittent 502s from the upload service"],
    [102, "Extract last_seen_at", "Move last_seen_at out of the sessions JSON blob.", "Migrate sessions table from JSON blobs to columns"],
    [201, "Safari checkout crash", "Checkout fails on Safari 17 when ApplePaySession is missing.", "Checkout page crashes on Safari 17 when Apple Pay is unavailable"],
    [302, "Postgres cert expiry", "The Postgres server certificate expires soon; roll new certs.", "Rotate the Postgres TLS certificates before expiry"],
    [301, "CI long-poll failure", "queue-wait times out on loaded CI runners.", "CI: deflake tests/queue-wait timeout on loaded runners"],
    [401, "Infinite sign-in redirect", "OAuth loops when the state cookie is dropped.", "OAuth login loops when the state cookie is missing"],
    [303, "Slim worker image", "The worker Dockerfile ships devDependencies in the production layer.", "Reduce Docker image size for the worker"],
    [202, "Chart hover labels hidden", "The tooltip is behind the modal overlay due to z-index.", "Dashboard chart tooltips render behind the modal overlay"],
  ])("merges a natural-language duplicate into the unique grounded target #%i", async (id, title, body, existingTitle) => {
    const d = new FakeDriver();
    const mergeCtx: MediatorContext = {
      ...ctx,
      queue: [
        { id, title: existingTitle, state: "QUEUED", priority: 1 },
        { id: 999, title: "Unrelated settings cleanup", state: "QUEUED", priority: 3 },
      ],
    };
    await expect(d.groom(mergeCtx, {
      taskId: 50, title, body, priority: 1, submittedBy: "dana", evidence: [{ kind: "log", snippet: "reproduced" }],
    })).resolves.toMatchObject({ action: "merge", into_task_id: id });
  });

  it("does not merge weak, tied, or unrelated natural-language matches", async () => {
    const d = new FakeDriver();
    const weakCtx: MediatorContext = {
      ...ctx,
      queue: [{ id: 1, title: "Dashboard chart tooltips render behind the modal overlay", state: "QUEUED", priority: 1 }],
    };
    await expect(d.groom(weakCtx, {
      taskId: 51, title: "Change chart colors", body: "Use the brand palette on charts.", priority: 2, submittedBy: "dana", evidence: [],
    })).resolves.toMatchObject({ action: "accept" });

    const tiedCtx: MediatorContext = {
      ...ctx,
      queue: [
        { id: 1, title: "Rate limiting for the public API", state: "QUEUED", priority: 1 },
        { id: 2, title: "Public REST API request throttling", state: "QUEUED", priority: 1 },
      ],
    };
    await expect(d.groom(tiedCtx, {
      taskId: 52, title: "Throttle public API clients", body: "Cap request rates on public REST endpoints.", priority: 1, submittedBy: "dana", evidence: [],
    })).resolves.toMatchObject({ action: "accept" });

    await expect(d.groom(ctx, {
      taskId: 53, title: "Add keyboard shortcuts", body: "Add Cmd-K navigation.", priority: 2, submittedBy: "dana", evidence: [],
    })).resolves.toMatchObject({ action: "accept" });
  });

  it("does not merge the same data nouns when the requested intent differs", async () => {
    const d = new FakeDriver();
    const sessionsCtx: MediatorContext = {
      ...ctx,
      queue: [{ id: 102, title: "Migrate sessions table from JSON blobs to columns", state: "QUEUED", priority: 2 }],
    };
    await expect(d.groom(sessionsCtx, {
      taskId: 56,
      title: "Encrypt sessions JSON blobs at rest while retaining schema",
      body: "Add envelope encryption for sessions.data JSON blobs without changing their schema.",
      priority: 1,
      submittedBy: "dana",
      evidence: [{ kind: "code", path: "src/db/sessions.ts" }],
    })).resolves.toMatchObject({ action: "accept" });
    await expect(d.groom(sessionsCtx, {
      taskId: 57,
      title: "Document sessions JSON blob fields",
      body: "Write a schema reference for the existing sessions JSON blobs.",
      priority: 3,
      submittedBy: "dana",
      evidence: [],
    })).resolves.toMatchObject({ action: "accept" });
  });

  it("clarifies only scope-less submissions and emits one schema-shaped recommendation", async () => {
    const d = new FakeDriver();
    const vague = await d.groom(ctx, {
      taskId: 54, title: "Make the app faster", body: "Everything feels slow. Make it faster.", priority: 1, submittedBy: "dana", evidence: [],
    });
    expect(vague.action).toBe("clarify");
    if (vague.action === "clarify") {
      expect(vague.question.match(/\?/g)).toHaveLength(1);
      expect(vague.question).toMatch(/Recommended: .+ — .+/);
    }
    await expect(d.groom(ctx, {
      taskId: 55, title: "Add keyboard shortcuts", body: "Add Cmd-K to open navigation and cover it with a browser test.", priority: 2, submittedBy: "dana", evidence: [],
    })).resolves.toMatchObject({ action: "accept" });
  });

  it("reviews: approve and revise", async () => {
    const d = new FakeDriver();
    expect(await d.review(ctx, { taskId: 1, task: reviewTask, plan: "solid plan" })).toMatchObject({
      verdict: "approved",
      feedback: "",
      rationale: "plan is sound",
    });
    expect(await d.review(ctx, { taskId: 1, task: reviewTask, plan: "a bad plan" })).toMatchObject({
      verdict: "revise",
      feedback: "plan flagged as bad",
      rationale: "plan contains known defect marker",
    });
  });

  it("reviews explicit task criteria and returns specific actionable feedback", async () => {
    const d = new FakeDriver();
    const reviewCtx: MediatorContext = {
      ...ctx,
      decisions: [{ kind: "create", task_id: 1, summary: "created task", rationale: "Task spec: SIGTERM must stop new connections, allow in-flight requests up to 25s, and have an integration test." }],
    };
    await expect(d.review(reviewCtx, {
      taskId: 1,
      task: {
        title: "Graceful shutdown",
        body: "SIGTERM must stop new connections, allow in-flight requests up to 25s, and have an integration test.",
        groomingRationale: "bounded shutdown task",
      },
      plan: "Call server.close(), wait for its callback, and integration-test an in-flight request.",
    })).resolves.toMatchObject({ verdict: "revise", feedback: expect.stringMatching(/25-second.*test/i) });
    await expect(d.review(reviewCtx, {
      taskId: 1,
      task: {
        title: "Graceful shutdown",
        body: "SIGTERM must stop new connections, allow in-flight requests up to 25s, and have an integration test.",
        groomingRationale: "bounded shutdown task",
      },
      plan: "Call server.close(), force-exit after 25 seconds, and integration-test an in-flight request across SIGTERM.",
    })).resolves.toMatchObject({ verdict: "approved" });
  });

  it("reviews only the current groomed task even when decisions describe broader scope", async () => {
    const d = new FakeDriver();
    const mixedCtx: MediatorContext = {
      ...ctx,
      decisions: [
        { kind: "create", task_id: 99, summary: "created task 99", rationale: "Task spec: a regression test is required." },
        { kind: "create", task_id: 1, summary: "created task 1", rationale: "Task spec: preserve the existing response format." },
      ],
    };
    await expect(d.review(mixedCtx, {
      taskId: 1,
      task: {
        title: "Parser",
        body: "Preserve the existing response format.",
        groomingRationale: "Moved the automated regression test to task 99.",
      },
      plan: "Update the parser and preserve the existing response format.",
    }))
      .resolves.toMatchObject({ verdict: "approved" });

    const scopedCtx: MediatorContext = {
      ...ctx,
      decisions: [{ kind: "create", task_id: 1, summary: "created task 1", rationale: "Task spec: an automated regression test is required." }],
    };
    await expect(d.review(scopedCtx, {
      taskId: 1,
      task: { title: "Parser", body: "An automated regression test is required.", groomingRationale: "accepted criterion" },
      plan: "Update the parser and verify it manually.",
    }))
      .resolves.toMatchObject({ verdict: "revise", feedback: expect.stringMatching(/automated regression test/i) });
  });

  it("discuss: close and set-priority directives become actions", async () => {
    const d = new FakeDriver();
    expect(await d.discuss(ctx, { message: "close task 7: already shipped in #42", from: "dana" })).toMatchObject({
      reply: "done: 1 action(s)",
      actions: [{ action: "close_task", task_id: 7, reason: "already shipped in #42" }],
      rationale: "parsed member directives",
    });
    expect(await d.discuss(ctx, { message: "set task 3 to P0", from: "dana" })).toMatchObject({
      reply: "done: 1 action(s)",
      actions: [{ action: "set_priority", task_id: 3, priority: 0, reason: "member request" }],
      rationale: "parsed member directives",
    });
    const both = await d.discuss(ctx, { message: "close task 7: obsolete\nset task 3 to P1", from: "dana" });
    expect(both.actions).toEqual([
      { action: "close_task", task_id: 7, reason: "obsolete" },
      { action: "set_priority", task_id: 3, priority: 1, reason: "member request" },
    ]);
  });

  it("discuss: a plain question yields no actions", async () => {
    const d = new FakeDriver();
    expect(await d.discuss(ctx, { message: "what's next in the queue?", from: "dana" })).toMatchObject({
      reply: "noted",
      actions: [],
      rationale: "no directives in the message",
    });
  });

  it("answer: a close directive in the question yields a close action on that task", async () => {
    const d = new FakeDriver();
    const result = await d.answer(ctx, { taskId: 7, question: "close task 7: endpoint was removed upstream" });
    expect(result).toMatchObject({
      escalate: false,
      answer: "closed task 7: endpoint was removed upstream",
      actions: [{ action: "close_task", task_id: 7, reason: "endpoint was removed upstream" }],
      rationale: "question revealed the task premise is wrong",
    });
  });

  it("enhance: merges a plain contribution, refuses scope creep, clarifies ambiguity (#62)", async () => {
    const d = new FakeDriver();
    const base = { taskId: 9, title: "warm", body: "Outcome: ship X", from: "evan" };
    const merged = await d.enhance(ctx, { ...base, contribution: "add a rate-limit criterion" });
    expect(merged).toEqual({
      action: "merge",
      body: "Outcome: ship X\n\nContribution from evan: add a rate-limit criterion",
      rationale: "merged evan's contribution into the canonical spec",
    });
    const refused = await d.enhance(ctx, { ...base, contribution: "SCOPECREEP rewrite billing" });
    expect(refused.action).toBe("refuse");
    if (refused.action === "refuse") expect(refused.rationale).toMatch(/out of scope/i);
    const clarified = await d.enhance(ctx, { ...base, contribution: "CLARIFY: which region?" });
    expect(clarified).toEqual({
      action: "clarify",
      question: "which region?",
      rationale: "contribution leaves an ambiguity",
    });
  });

  it("answers or escalates", async () => {
    const d = new FakeDriver();
    expect(await d.answer(ctx, { taskId: 1, question: "meaning of life?" })).toMatchObject({
      escalate: false,
      answer: "42",
      rationale: "answered from context",
    });
    expect(await d.answer(ctx, { taskId: 1, question: "please escalate this" })).toMatchObject({
      escalate: true,
      rationale: "needs a human",
    });
  });

  it("answers factual questions but escalates human-owned decisions", async () => {
    const d = new FakeDriver();
    await expect(d.answer(ctx, { taskId: 1, question: "Should the BOM be before the CSV header row?" }))
      .resolves.toMatchObject({ escalate: false });
    await expect(d.answer(ctx, { taskId: 1, question: "Do we have budget approval for the $450/month runner?" }))
      .resolves.toMatchObject({ escalate: true, rationale: expect.stringMatching(/human-owned/i) });
    await expect(d.answer(ctx, { taskId: 1, question: "Which license does the existing chart library use?" }))
      .resolves.toMatchObject({ escalate: false });
    await expect(d.answer(ctx, { taskId: 1, question: "What is the maintenance window?" }))
      .resolves.toMatchObject({ escalate: false });
    await expect(d.answer(ctx, { taskId: 1, question: "What is the documented $450/month runner cost?" }))
      .resolves.toMatchObject({ escalate: false });
    await expect(d.answer(ctx, { taskId: 1, question: "Which service costs $10 per month?" }))
      .resolves.toMatchObject({ escalate: false });
  });
});
