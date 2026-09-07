// tests/tools-coder-report-finding.test.ts
// Coder mid-task findings: never-skip contract + coder_report_finding tool.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { parseToolResult, submitAndWait } from "./helpers/async-human.js";
import { CODER_ROLE_CONTRACT } from "../src/dashboard/public/role-contracts.js";

let db: ReturnType<typeof openDb>;
let server: Server;
let worker: MediatorWorker;
let baseUrl: string;
let tokH: string;
let tokC: string;

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','recallnet/demo-app')").run();
  tokH = (await seedMember(db, { name: "dana", projectId: "demo", role: "human" })).token;
  tokC = (await seedMember(db, { name: "cc-7f2", projectId: "demo", role: "coder" })).token;
  const made = createApp(db, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 10, jobTimeoutMs: 2000 },
  });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    server = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "coder-report-finding-test", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function submitAndClaim(): Promise<{ human: Client; coder: Client; sourceId: number }> {
  const human = await connect(tokH);
  const coder = await connect(tokC);
  const submitted = await submitAndWait(human, {
    project: "demo",
    title: "ship the feature",
    body: "FEATURE: implement the feature with tests and a PR.",
    evidence: [],
  });
  expect(submitted.task?.state).toBe("QUEUED");
  const brief = parseToolResult(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
  expect(brief?.id).toBe(submitted.task.id);
  return { human, coder, sourceId: brief.id as number };
}

describe("CODER_ROLE_CONTRACT never-skip findings", () => {
  it("names coder_report_finding and never-skip rules", () => {
    expect(CODER_ROLE_CONTRACT).toContain("coder_report_finding");
    expect(CODER_ROLE_CONTRACT).toMatch(/never silently skip/i);
    expect(CODER_ROLE_CONTRACT).toMatch(/security/i);
  });
});

describe("coder_report_finding", () => {
  it("is registered on the coder tool list", async () => {
    const coder = await connect(tokC);
    const names = (await coder.listTools()).tools.map((t) => t.name);
    expect(names).toContain("coder_report_finding");
    await coder.close();
  });

  it("files a parent-linked finding under an active lease without touching the source", async () => {
    const { human, coder, sourceId } = await submitAndClaim();
    const before = await db
      .prepare("SELECT state, lease_agent, lease_expires_at FROM tasks WHERE id=?")
      .get<{ state: string; lease_agent: string; lease_expires_at: number }>(sourceId);

    const res = parseToolResult(
      await coder.callTool({
        name: "coder_report_finding",
        arguments: {
          task_id: sourceId,
          title: "fix typo in error path",
          body: "src/foo.ts:42 logs the wrong status code on 403.",
          severity: "nit",
          evidence: [{ kind: "code", path: "src/foo.ts", lines: "42", note: "wrong status" }],
        },
      }),
    );

    expect(res.state).toBe("GROOMING");
    expect(res.parent_id).toBe(sourceId);
    expect(typeof res.task_id).toBe("number");
    expect(res.task_id).not.toBe(sourceId);
    expect(typeof res.job_id).toBe("number");
    expect(res.idempotent_replay).toBe(false);

    const child = await db
      .prepare("SELECT parent_id, submitted_by, priority, title, body, state FROM tasks WHERE id=?")
      .get<{
        parent_id: number;
        submitted_by: string;
        priority: number;
        title: string;
        body: string;
        state: string;
      }>(res.task_id);
    expect(child?.parent_id).toBe(sourceId);
    // Ownership is the parent human so clarify routes to real humans, not the coder seat.
    expect(child?.submitted_by).toBe("dana");
    expect(child?.priority).toBe(2); // nit
    expect(child?.title).toBe("fix typo in error path");
    expect(child?.body).toMatch(new RegExp(`Discovered while working task #${sourceId}`));
    expect(child?.body).toMatch(/Severity: nit/i);
    expect(child?.body).toContain("src/foo.ts:42 logs the wrong status code on 403.");

    const after = await db
      .prepare("SELECT state, lease_agent, lease_expires_at FROM tasks WHERE id=?")
      .get<{ state: string; lease_agent: string; lease_expires_at: number }>(sourceId);
    expect(after?.state).toBe(before?.state);
    expect(after?.lease_agent).toBe(before?.lease_agent);
    expect(after?.lease_expires_at).toBeGreaterThanOrEqual(before!.lease_expires_at);

    const job = await db
      .prepare("SELECT kind, status FROM jobs WHERE id=?")
      .get<{ kind: string; status: string }>(res.job_id);
    expect(job?.kind).toBe("groom");

    await human.close();
    await coder.close();
  });

  it("rejects when the caller has no live lease on the source task", async () => {
    const human = await connect(tokH);
    const coder = await connect(tokC);
    const sub = parseToolResult(
      await human.callTool({
        name: "human_submit",
        arguments: {
          project: "demo",
          title: "unclaimed work",
          body: "FEATURE: something for someone else.",
          evidence: [],
        },
      }),
    );
    // Wait until the task exists; do not claim.
    let taskId = sub.task_id as number;
    for (let i = 0; i < 50 && !taskId; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const err = await coder.callTool({
      name: "coder_report_finding",
      arguments: {
        task_id: taskId,
        title: "stray finding",
        body: "Should fail without a lease on the source task.",
      },
    });
    expect(err.isError || (err as { isError?: boolean }).isError).toBeTruthy();
    const text = ((err.content as { type: string; text: string }[]) ?? [])
      .map((c) => c.text)
      .join(" ");
    expect(text).toMatch(/no live lease|not found|lease/i);

    await human.close();
    await coder.close();
  });

  it("replays the same finding under an idempotency_key", async () => {
    const { human, coder, sourceId } = await submitAndClaim();
    const args = {
      task_id: sourceId,
      title: "null check missing",
      body: "src/bar.ts:10 can throw when config is absent.",
      severity: "fix" as const,
      idempotency_key: `finding-${sourceId}-null-check`,
    };
    const first = parseToolResult(await coder.callTool({ name: "coder_report_finding", arguments: args }));
    const second = parseToolResult(await coder.callTool({ name: "coder_report_finding", arguments: args }));
    expect(second.task_id).toBe(first.task_id);
    expect(second.idempotent_replay).toBe(true);
    expect(second.parent_id).toBe(sourceId);

    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id=? AND title=?")
      .get<{ n: number }>(sourceId, "null check missing");
    expect(count?.n).toBe(1);

    await human.close();
    await coder.close();
  });

  it("does not replay the same idempotency_key across different source tasks", async () => {
    const { human, coder, sourceId } = await submitAndClaim();
    const key = "shared-key-across-tasks";
    const first = parseToolResult(
      await coder.callTool({
        name: "coder_report_finding",
        arguments: {
          task_id: sourceId,
          title: "finding on task A",
          body: "First source task finding body with enough detail.",
          idempotency_key: key,
        },
      }),
    );
    // Release lease so another task can be claimed under the same coder key.
    await coder.callTool({
      name: "coder_release",
      arguments: { task_id: sourceId, reason: "switch tasks for cross-key idempotency test" },
    });
    const secondSource = await submitAndWait(human, {
      project: "demo",
      title: "second feature",
      body: "FEATURE: another leased task for cross-key test.",
      evidence: [],
    });
    // Claim until we hold the second human task (findings may also be QUEUED).
    let heldId: number | null = null;
    for (let i = 0; i < 5; i++) {
      const brief = parseToolResult(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
      if (!brief?.id) break;
      if (brief.id === secondSource.task.id) {
        heldId = brief.id as number;
        break;
      }
      await coder.callTool({
        name: "coder_release",
        arguments: { task_id: brief.id, reason: "skip non-target for cross-key test" },
      });
    }
    expect(heldId).toBe(secondSource.task.id);
    const second = parseToolResult(
      await coder.callTool({
        name: "coder_report_finding",
        arguments: {
          task_id: heldId!,
          title: "finding on task B",
          body: "Second source task finding body with enough detail.",
          idempotency_key: key,
        },
      }),
    );
    expect(second.task_id).not.toBe(first.task_id);
    expect(second.parent_id).toBe(heldId);
    expect(second.idempotent_replay).toBe(false);
    await human.close();
    await coder.close();
  });

  it("keeps parent_id lineage from the original finding on idempotent replay", async () => {
    const { human, coder, sourceId } = await submitAndClaim();
    const args = {
      task_id: sourceId,
      title: "lineage check",
      body: "Ensure parent_id is not re-stamped from a later lease context.",
      idempotency_key: "lineage-key",
    };
    const first = parseToolResult(await coder.callTool({ name: "coder_report_finding", arguments: args }));
    expect(first.parent_id).toBe(sourceId);
    const replay = parseToolResult(await coder.callTool({ name: "coder_report_finding", arguments: args }));
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.parent_id).toBe(sourceId);
    const child = await db
      .prepare("SELECT parent_id, submitted_by FROM tasks WHERE id=?")
      .get<{ parent_id: number; submitted_by: string }>(first.task_id);
    expect(child?.parent_id).toBe(sourceId);
    expect(child?.submitted_by).toBe("dana");
    await human.close();
    await coder.close();
  });

  it("rejects same-submitter content duplicates without a key as duplicate", async () => {
    const { human, coder, sourceId } = await submitAndClaim();
    const args = {
      task_id: sourceId,
      title: "memory leak in poller",
      body: "The long-poll loop retains closed streams forever.",
      severity: "security" as const,
    };
    const first = parseToolResult(await coder.callTool({ name: "coder_report_finding", arguments: args }));
    expect(first.task_id).toBeTruthy();
    const second = parseToolResult(await coder.callTool({ name: "coder_report_finding", arguments: args }));
    expect(second.status === "duplicate" || second.duplicate_of === first.task_id).toBe(true);
    expect(second.task_id ?? second.duplicate_of).toBe(first.task_id);

    const child = await db
      .prepare("SELECT priority FROM tasks WHERE id=?")
      .get<{ priority: number }>(first.task_id);
    expect(child?.priority).toBe(0); // security

    await human.close();
    await coder.close();
  });
});
