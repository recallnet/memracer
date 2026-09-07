import { describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import {
  executeProjectMemoryConsolidation,
  memoryDocsWatermark,
  parseRecoverySnapshot,
  planProjectMemoryConsolidation,
  rewriteConsolidatedMarkdownLinks,
  serializeRecoverySnapshot,
  StaleConsolidationPlanError,
  type ConsolidationSpec,
} from "../src/mediator/okf-consolidation.js";
import { MemoryStore, type MemoryDocInput } from "../src/mediator/memory.js";
import {
  restoreProjectMemory,
  snapshotProjectMemory,
  snapshotsEquivalent,
} from "../src/mediator/okf-migration.js";
import { openTestDb, testDialect } from "./helpers/db.js";

async function setup(): Promise<Db> {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  await db.prepare(
    "INSERT INTO tasks (id, project_id, title, body, submitted_by, created_at, updated_at) VALUES (205, 'p', 'Memory consolidation', 'Reviewed migration', 'human', 1, 1)",
  ).run();
  return db;
}

async function insertDoc(db: Db, doc: MemoryDocInput, updatedAt: number): Promise<void> {
  await db.prepare(
    `INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at)
     VALUES ('p', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(doc.path, doc.type, doc.title, doc.description, JSON.stringify(doc.tags), doc.body, updatedAt);
}

const oldRetry: MemoryDocInput = {
  path: "decisions/retry-old.md",
  type: "Decision",
  title: "Retry legacy",
  description: "Old retry policy",
  tags: ["retry"],
  body: "# Context\n\nRetry failed requests five times.\n\n# Citations\n\n- TASK-12\n- [Runbook](../runbooks/retry.md)\n",
};

const retryEvidence: MemoryDocInput = {
  path: "learnings/retry-evidence.md",
  type: "Learning",
  title: "Retry evidence",
  description: "Backoff observation",
  tags: ["retry", "evidence"],
  body: "# What we learned\n\nBackoff prevents overload.\n\n## Citations\n\nEVID-7\n",
};

const retryTarget: MemoryDocInput = {
  path: "decisions/retry-policy.md",
  type: "Decision",
  title: "Retry policy",
  description: "Canonical bounded retry policy",
  tags: ["retry", "policy"],
  body:
    "# Context\n\nRetry failed requests five times. Backoff prevents overload.\n\n" +
    "# Rationale\n\nUse the [Runbook](../runbooks/retry.md).\n\n" +
    "# Status\n\nAccepted.\n\n# Consequences\n\nBounded retries.\n\n" +
    "## Citations\n\nTASK-12\n\n[Runbook](../runbooks/retry.md)\n\nEVID-7\n",
};

async function fixture(): Promise<{ db: Db; spec: ConsolidationSpec }> {
  const db = await setup();
  await insertDoc(db, oldRetry, 1);
  await insertDoc(db, retryEvidence, 2);
  await insertDoc(db, {
    path: "architecture.md",
    type: "Architecture",
    title: "Architecture",
    description: "System shape",
    tags: ["architecture"],
    body: "# Overview\n\nSee [old retry](decisions/retry-old.md).\n",
  }, 3);
  await insertDoc(db, {
    path: "runbooks/retry.md",
    type: "Runbook",
    title: "Retry runbook",
    description: "Operate retries",
    tags: ["retry"],
    body:
      "# Steps\n\nSee [legacy](../decisions/retry-old.md).\n\n" +
      "`[inline example](../decisions/retry-old.md)`\n\n" +
      "```md\n[fenced example](../decisions/retry-old.md)\n```\n",
  }, 4);
  await insertDoc(db, {
    path: "questions/open-questions.md",
    type: "Reference",
    title: "Open questions ledger",
    description: "System-owned questions",
    tags: ["questions"],
    body: "# Open\n\nWhich platform is next?\n",
  }, 5);
  await db.prepare("INSERT INTO memory_log (project_id, entry, created_at) VALUES ('p','before',1)").run();

  return {
    db,
    spec: {
      projectId: "p",
      auditTaskId: 205,
      sourceManifest: ["architecture.md", oldRetry.path, retryEvidence.path, "runbooks/retry.md"],
      expectedResultPaths: [
        "architecture.md",
        retryTarget.path,
        "questions/open-questions.md",
        "runbooks/retry.md",
      ],
      operations: [{
        sourcePaths: [oldRetry.path, retryEvidence.path],
        target: retryTarget,
        preserve: {
          bySource: {
            [oldRetry.path]: { claims: ["Retry failed requests five times."] },
            [retryEvidence.path]: { claims: ["Backoff prevents overload."] },
          },
        },
      }, {
        sourcePaths: ["architecture.md"],
        target: {
          path: "architecture.md",
          type: "Architecture",
          title: "Architecture",
          description: "System shape",
          tags: ["architecture"],
          body: "# Overview\n\nSee [old retry](decisions/retry-old.md).\n",
        },
        preserve: { bySource: { "architecture.md": { claims: ["See [old retry](decisions/retry-old.md)."] } } },
      }, {
        sourcePaths: ["runbooks/retry.md"],
        target: {
          path: "runbooks/retry.md",
          type: "Runbook",
          title: "Retry runbook",
          description: "Operate retries",
          tags: ["retry"],
          body:
            "# Steps\n\nSee [legacy](../decisions/retry-old.md).\n\n" +
            "`[inline example](../decisions/retry-old.md)`\n\n" +
            "```md\n[fenced example](../decisions/retry-old.md)\n```\n",
        },
        preserve: { bySource: { "runbooks/retry.md": { claims: ["See [legacy](../decisions/retry-old.md)."] } } },
      }],
    },
  };
}

describe("project-memory semantic consolidation", () => {
  it("plans from a recovery snapshot, dry-runs by default, rewrites links, and preserves code examples", async () => {
    const { db, spec } = await fixture();
    const before = await snapshotProjectMemory(db, "p");
    const plan = await planProjectMemoryConsolidation(db, spec);
    const parsed = parseRecoverySnapshot(serializeRecoverySnapshot(plan.snapshot));

    expect(snapshotsEquivalent(parsed, before)).toBe(true);
    expect(plan.sourceWatermark).toBe(memoryDocsWatermark(before.docs));
    expect(plan.resultWatermark).toBe(memoryDocsWatermark(plan.candidateDocs));
    expect(plan.removedPaths).toEqual([oldRetry.path, retryEvidence.path]);
    expect(plan.linkRewrites).toBe(2);
    expect(plan.reciprocalLinksAdded).toBe(1);

    const runbook = plan.candidateDocs.find((doc) => doc.path === "runbooks/retry.md")!;
    expect(runbook.body).toContain("[legacy](../decisions/retry-policy.md)");
    expect(runbook.body).toContain("`[inline example](../decisions/retry-old.md)`");
    expect(runbook.body).toContain("[fenced example](../decisions/retry-old.md)");
    expect(plan.candidateDocs.find((doc) => doc.path === retryTarget.path)!.body)
      .toContain("[Architecture](../architecture.md)");

    await expect(executeProjectMemoryConsolidation(db, plan)).resolves.toMatchObject({ status: "dry_run" });
    expect(snapshotsEquivalent(await snapshotProjectMemory(db, "p"), before)).toBe(true);
    await db.close();
  });

  it("atomically applies, validates, logs once, is idempotent, and restores from its snapshot", async () => {
    const { db, spec } = await fixture();
    const plan = await planProjectMemoryConsolidation(db, spec);
    const applyStartedAt = Date.now();

    const applied = await executeProjectMemoryConsolidation(db, plan, { apply: true });
    expect(applied).toMatchObject({ status: "applied", conceptsBefore: 5, conceptsAfter: 4 });
    expect(await new MemoryStore(db).get("p", oldRetry.path)).toBeNull();
    expect((await new MemoryStore(db).validateBundle("p"))).toMatchObject({ ok: true, graph_consistent: true });
    expect(await db.prepare("SELECT entry FROM memory_log ORDER BY id").all()).toHaveLength(2);
    expect(await db.prepare("SELECT task_id, created_at FROM memory_log ORDER BY id DESC LIMIT 1").get())
      .toEqual({ task_id: 205, created_at: expect.any(Number) });
    expect((await db.prepare("SELECT created_at FROM memory_log ORDER BY id DESC LIMIT 1").get<{ created_at: number }>())!.created_at)
      .toBeGreaterThanOrEqual(applyStartedAt);

    await expect(executeProjectMemoryConsolidation(db, plan, { apply: true }))
      .resolves.toMatchObject({ status: "already_applied" });
    expect(await db.prepare("SELECT entry FROM memory_log ORDER BY id").all()).toHaveLength(2);

    await restoreProjectMemory(db, applied.snapshot);
    expect(snapshotsEquivalent(await snapshotProjectMemory(db, "p"), applied.snapshot)).toBe(true);
    await db.close();
  });

  it("refuses a stale source watermark without replacing any current row", async () => {
    const { db, spec } = await fixture();
    const plan = await planProjectMemoryConsolidation(db, spec);
    const memory = new MemoryStore(db);
    const architecture = (await memory.get("p", "architecture.md"))!;
    await memory.upsert("p", { ...architecture, body: `${architecture.body}\nCurrent writer won.\n` });
    const changed = await snapshotProjectMemory(db, "p");

    await expect(executeProjectMemoryConsolidation(db, plan, { apply: true }))
      .rejects.toBeInstanceOf(StaleConsolidationPlanError);
    expect(snapshotsEquivalent(await snapshotProjectMemory(db, "p"), changed)).toBe(true);
    await db.close();
  });

  it("rejects claim, citation, path-manifest, and unresolved-link loss before replacement", async () => {
    const { db, spec } = await fixture();
    const before = await snapshotProjectMemory(db, "p");

    const droppedClaim = structuredClone(spec);
    droppedClaim.operations[0].target.body = droppedClaim.operations[0].target.body.replace("Backoff prevents overload.", "Backoff is useful.");
    await expect(planProjectMemoryConsolidation(db, droppedClaim)).rejects.toThrow(/drops preserved claim/);

    const droppedCitation = structuredClone(spec);
    droppedCitation.operations[0].target.body = droppedCitation.operations[0].target.body.replace("EVID-7", "");
    await expect(planProjectMemoryConsolidation(db, droppedCitation)).rejects.toThrow(/drops citation/);

    const missingPath = structuredClone(spec);
    missingPath.operations[0].target.body += "\n[Missing](../missing.md)\n";
    await expect(planProjectMemoryConsolidation(db, missingPath)).rejects.toThrow(/unresolved concept href/);

    const badManifest = structuredClone(spec);
    badManifest.sourceManifest = [oldRetry.path];
    await expect(planProjectMemoryConsolidation(db, badManifest)).rejects.toThrow(/sourceManifest/);

    expect(snapshotsEquivalent(await snapshotProjectMemory(db, "p"), before)).toBe(true);
    await db.close();
  });

  it("allows a single-source move and sanitizes opted-in literal escaped frontmatter", async () => {
    const db = await setup();
    await insertDoc(db, {
      path: "architecture/portable-agent.md",
      type: "Architecture",
      title: "Portable agent",
      description: "Legacy portable-agent note",
      tags: ["agent"],
      body: "---\\ntype: Architecture\\ntitle: old\\n---\\n# Overview\\n\\nAgent configuration is portable.\\n\\n### Citations\\n\\nTASK-9\\n",
    }, 1);
    const plan = await planProjectMemoryConsolidation(db, {
      projectId: "p",
      auditTaskId: 205,
      sourceManifest: ["architecture/portable-agent.md"],
      expectedResultPaths: ["tech/portable-agent-skill.md"],
      operations: [{
        sourcePaths: ["architecture/portable-agent.md"],
        target: {
          path: "tech/portable-agent-skill.md",
          type: "Architecture",
          title: "Portable agent skill",
          description: "Portable agent configuration",
          tags: ["agent"],
          body: "# Overview\n\nAgent configuration is portable.\n\n### Citations\n\nTASK-9\n",
        },
        preserve: { bySource: { "architecture/portable-agent.md": { claims: ["Agent configuration is portable."] } } },
        sanitizeEscapedFrontmatter: true,
      }],
    });
    expect(plan.candidateDocs).toHaveLength(1);
    expect(plan.candidateDocs[0].body).not.toContain("type: Architecture");
    await db.close();
  });

  it("allows one source to feed two targets while exactly one operation owns removal", async () => {
    const db = await setup();
    await insertDoc(db, {
      path: "architecture/queue-sweep.md",
      type: "Architecture",
      title: "Queue sweep",
      description: "Admission and human guidance",
      tags: ["queue"],
      body: "# Part A\n\nAdmission rechecks eligibility.\n\n# Part B\n\nHumans submit coherent outcomes.\n\n# Citations\n\nTASK-20\n",
    }, 1);
    const plan = await planProjectMemoryConsolidation(db, {
      projectId: "p",
      auditTaskId: 205,
      sourceManifest: ["architecture/queue-sweep.md"],
      expectedResultPaths: ["conventions/human-role-contract.md", "tech/task-admission.md"],
      operations: [
        {
          sourcePaths: ["architecture/queue-sweep.md"],
          removePaths: ["architecture/queue-sweep.md"],
          target: {
            path: "tech/task-admission.md", type: "Architecture", title: "Task admission",
            description: "Admission rules", tags: ["queue"],
            body: "# Overview\n\nAdmission rechecks eligibility.\n\n# Citations\n\nTASK-20\n",
          },
          preserve: { bySource: { "architecture/queue-sweep.md": { claims: ["Admission rechecks eligibility."] } } },
        },
        {
          sourcePaths: ["architecture/queue-sweep.md"],
          removePaths: [],
          target: {
            path: "conventions/human-role-contract.md", type: "Convention", title: "Human role contract",
            description: "Submission guidance", tags: ["human"],
            body: "# Rule\n\nHumans submit coherent outcomes.\n\n# Citations\n\nTASK-20\n",
          },
          preserve: { bySource: { "architecture/queue-sweep.md": { claims: ["Humans submit coherent outcomes."] } } },
        },
      ],
    });
    expect(plan.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetPath: "tech/task-admission.md", removePaths: ["architecture/queue-sweep.md"] }),
      expect.objectContaining({ targetPath: "conventions/human-role-contract.md", removePaths: [] }),
    ]));
    await db.close();
  });

  it("does not rewrite concept-link examples inside fenced or inline code", () => {
    const input = "[live](old.md) `[inline](old.md)`\n```md\n[fenced](old.md)\n```";
    const rewritten = rewriteConsolidatedMarkdownLinks(
      input,
      "guide.md",
      new Map([["old.md", "new.md"]]),
      new Set(["guide.md", "old.md"]),
    );
    expect(rewritten).toEqual({
      body: "[live](new.md) `[inline](old.md)`\n```md\n[fenced](old.md)\n```",
      rewrites: 1,
    });
  });

  it("captures post-plan log rows and their exposed ids in the apply-time rollback snapshot", async () => {
    const { db, spec } = await fixture();
    const plan = await planProjectMemoryConsolidation(db, spec);
    await db.prepare("INSERT INTO memory_log (project_id, entry, created_at) VALUES ('p','after plan',2)").run();
    const immediatelyBeforeApply = await snapshotProjectMemory(db, "p");

    const applied = await executeProjectMemoryConsolidation(db, plan, { apply: true });
    expect(snapshotsEquivalent(applied.snapshot, immediatelyBeforeApply)).toBe(true);
    expect(applied.snapshot.log.map((row) => [row.id, row.entry])).toEqual(
      immediatelyBeforeApply.log.map((row) => [row.id, row.entry]),
    );

    await restoreProjectMemory(db, applied.snapshot);
    expect(snapshotsEquivalent(await snapshotProjectMemory(db, "p"), immediatelyBeforeApply)).toBe(true);
    await db.close();
  });

  it("revalidates source preservation when a saved plan candidate and result watermark are tampered", async () => {
    const { db, spec } = await fixture();
    const plan = await planProjectMemoryConsolidation(db, spec);
    const tampered = structuredClone(plan);
    const target = tampered.candidateDocs.find((doc) => doc.path === retryTarget.path)!;
    target.body = target.body.replace("Backoff prevents overload.", "Backoff was discarded.");
    tampered.resultWatermark = memoryDocsWatermark(tampered.candidateDocs);

    await expect(executeProjectMemoryConsolidation(db, tampered, { apply: true }))
      .rejects.toThrow(/drops preserved claim/);
    await db.close();
  });

  it("requires exact per-source claim coverage", async () => {
    const { db, spec } = await fixture();
    delete spec.operations[0].preserve.bySource[retryEvidence.path];
    await expect(planProjectMemoryConsolidation(db, spec)).rejects.toThrow(/cover every source exactly/);
    await db.close();
  });

  it("rejects bundle-root-looking hrefs whose canonical relative destination is different", async () => {
    const { db, spec } = await fixture();
    spec.operations[2].target.body += "\n[Retry](decisions/retry-policy.md)\n";
    await expect(planProjectMemoryConsolidation(db, spec)).rejects.toThrow(/unresolved concept href decisions\/retry-policy\.md/);
    await db.close();
  });

  it("rolls back docs and log ids when a candidate insert fails after delete", async () => {
    const { db, spec } = await fixture();
    const plan = await planProjectMemoryConsolidation(db, spec);
    const before = await snapshotProjectMemory(db, "p");
    if (testDialect() === "postgres") {
      await db.exec(`CREATE FUNCTION reject_consolidated_target_fn() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected candidate failure'; END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_consolidated_target
        BEFORE INSERT ON memory_docs
        FOR EACH ROW WHEN (NEW.path = 'decisions/retry-policy.md')
        EXECUTE FUNCTION reject_consolidated_target_fn()`);
    } else {
      await db.exec(`CREATE TRIGGER reject_consolidated_target
        BEFORE INSERT ON memory_docs
        WHEN NEW.path = 'decisions/retry-policy.md'
        BEGIN SELECT RAISE(ABORT, 'injected candidate failure'); END`);
    }

    await expect(executeProjectMemoryConsolidation(db, plan, { apply: true }))
      .rejects.toThrow(/injected candidate failure/);
    const after = await snapshotProjectMemory(db, "p");
    expect(snapshotsEquivalent(after, before)).toBe(true);
    expect(after.log.map((row) => row.id)).toEqual(before.log.map((row) => row.id));
    await db.close();
  });

  it("rolls back when the persisted candidate differs from the reviewed result watermark", async () => {
    const { db, spec } = await fixture();
    const plan = await planProjectMemoryConsolidation(db, spec);
    const before = await snapshotProjectMemory(db, "p");
    if (testDialect() === "postgres") {
      await db.exec(`CREATE FUNCTION mutate_consolidated_target_fn() RETURNS trigger AS $$
        BEGIN NEW.body := NEW.body || E'\\ncoerced after review'; RETURN NEW; END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER mutate_consolidated_target
        BEFORE INSERT ON memory_docs
        FOR EACH ROW WHEN (NEW.path = 'decisions/retry-policy.md')
        EXECUTE FUNCTION mutate_consolidated_target_fn()`);
    } else {
      await db.exec(`CREATE TRIGGER mutate_consolidated_target
        AFTER INSERT ON memory_docs
        WHEN NEW.path = 'decisions/retry-policy.md'
        BEGIN UPDATE memory_docs SET body = body || '\ncoerced after review'
          WHERE project_id = NEW.project_id AND path = NEW.path; END`);
    }

    await expect(executeProjectMemoryConsolidation(db, plan, { apply: true }))
      .rejects.toThrow(/persisted result does not match reviewed plan/);
    expect(snapshotsEquivalent(await snapshotProjectMemory(db, "p"), before)).toBe(true);
    await db.close();
  });

  it("rejects unsafe document timestamps and system-owned operation targets", async () => {
    const { db, spec } = await fixture();
    const plan = await planProjectMemoryConsolidation(db, spec);
    plan.candidateDocs[0].updated_at = 1.5;
    await expect(executeProjectMemoryConsolidation(db, plan)).rejects.toThrow(/invalid updated_at/);

    const protectedTarget = structuredClone(spec);
    protectedTarget.operations[0].target.path = "questions/open-questions.md";
    await expect(planProjectMemoryConsolidation(db, protectedTarget))
      .rejects.toThrow(/system-owned concept cannot be a consolidation target/);
    await db.close();
  });

  it("rejects recovery snapshots that omit exposed memory-log ids", () => {
    expect(() => parseRecoverySnapshot(JSON.stringify({
      project_id: "p", taken_at: 1, docs: [], log: [{ entry: "old", task_id: null, created_at: 1 }],
    }))).toThrow(/requires its original integer id/);
    expect(() => parseRecoverySnapshot(JSON.stringify({
      project_id: "p", taken_at: 1,
      docs: [{ path: "bad.md", type: "Reference", title: "Bad", description: "Bad", tags: [], body: "# Summary\n\nBad", updated_at: 1.5 }],
      log: [],
    }))).toThrow(/safe integer updated_at/);
  });

  it("rejects a saved plan that removes a source after dropping its coverage", async () => {
    const { db, spec } = await fixture();
    const plan = await planProjectMemoryConsolidation(db, spec);
    const tampered = structuredClone(plan);
    const operation = tampered.operations.find((candidate) => candidate.targetPath === retryTarget.path)!;
    operation.sourcePaths = operation.sourcePaths.filter((path) => path !== retryEvidence.path);
    delete operation.sourceCoverage[retryEvidence.path];
    await expect(executeProjectMemoryConsolidation(db, tampered)).rejects.toThrow(/removes .* without source coverage/);
    await db.close();
  });

  it("revalidates saved-plan audit task ownership", async () => {
    const { db, spec } = await fixture();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('other','Other')").run();
    await db.prepare(
      "INSERT INTO tasks (id, project_id, title, body, submitted_by, created_at, updated_at) VALUES (206, 'other', 'Other task', 'Other', 'human', 1, 1)",
    ).run();
    const plan = await planProjectMemoryConsolidation(db, spec);
    plan.auditTaskId = 206;
    await expect(executeProjectMemoryConsolidation(db, plan, { apply: true }))
      .rejects.toThrow(/audit task 206 does not belong/);
    await db.close();
  });

  it("rejects an unowned candidate path even when mutable manifests and watermarks are updated", async () => {
    const { db, spec } = await fixture();
    const plan = await planProjectMemoryConsolidation(db, spec);
    plan.candidateDocs.push({
      path: "decisions/injected.md", type: "Decision", title: "Injected",
      description: "Unowned candidate", tags: ["injected"],
      body: "# Context\n\nInjected.\n\n# Rationale\n\nNone.\n\n# Status\n\nAccepted.\n\n# Consequences\n\nNone.\n\n# Citations\n\nNone.\n",
      updated_at: 99,
    });
    plan.expectedResultPaths.push("decisions/injected.md");
    plan.resultWatermark = memoryDocsWatermark(plan.candidateDocs);
    await expect(executeProjectMemoryConsolidation(db, plan)).rejects.toThrow(/not owned by an operation/);
    await db.close();
  });
});
