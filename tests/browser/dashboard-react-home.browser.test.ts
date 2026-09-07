import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../../src/db.js";
import { createApp } from "../../src/server.js";
import { FakeDriver } from "../../src/mediator/fake.js";
import { DEFAULT_LEASE_TTL_MS } from "../../src/queue.js";
import type { Queue } from "../../src/queue.js";
import { encryptSecret } from "../../src/secrets.js";
import { betterAuthReady, grantMembership, magicLinkSessionCookie, latestMagicLink, seedProjectSeat } from "../helpers/auth.js";
import {
  ImageAttachmentService,
  type ImageBlobStore,
  type ImageMimeType,
} from "../../src/image-attachments.js";

const EMAIL = "operator@react-home.test";
const MEMBER_EMAIL = "member@react-home.test";
/** Match auth helper default so BYOK envelope decrypts under createApp. */
const FIXTURE_AUTH_SECRET = "memracer-dev-better-auth-secret-0123456789-abcdef";
let browser: Browser;
let context: BrowserContext;
let page: Page;
let server: Server;
let baseUrl: string;
let stopWorker: () => void;
let dbRef: ReturnType<typeof openDb>;
let activeTaskId: number;
let timelineRootThreadId: number;
let timelineChildThreadId: number;
let queueRef: Queue;
let doneTaskId: number;
let blockedTaskId: number;

class BrowserImageBlobStore implements ImageBlobStore {
  private readonly objects = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array, _mimeType: ImageMimeType): Promise<void> {
    this.objects.set(key, Uint8Array.from(bytes));
  }
  async get(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("missing browser fixture image");
    return Uint8Array.from(bytes);
  }
  async delete(key: string): Promise<void> { this.objects.delete(key); }
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || FIXTURE_AUTH_SECRET;
  const secretsEnv = { BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET };
  const db = openDb(":memory:");
  dbRef = db;
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("raceway", "Signal Raceway", "recallnet/memracer");
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("empty", "Empty Project", "recallnet/empty");
  await betterAuthReady(db);
  await magicLinkSessionCookie(db, EMAIL, "Operator");
  const userId = (await db.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>(EMAIL))!.id;
  await grantMembership(db, userId, { projectId: "raceway", projectName: "Signal Raceway", role: "admin" });
  await grantMembership(db, userId, { projectId: "empty", projectName: "Empty Project", role: "admin" });
  await magicLinkSessionCookie(db, MEMBER_EMAIL, "Project Member");
  const memberId = (await db.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>(MEMBER_EMAIL))!.id;
  await grantMembership(db, memberId, { projectId: "raceway", projectName: "Signal Raceway", role: "human" });
  await db.prepare('UPDATE "member" SET "createdAt" = ? WHERE "organizationId" = ? AND "userId" IN (?, ?)')
    .run("2026-07-15T12:03:07.245Z", "raceway", userId, memberId);
  // Mature raceway has connected human+coder MCP seats so Get started stays hidden.
  const seatNow = Date.now();
  await db
    .prepare(
      `INSERT INTO oauth_seats (id, user_id, project_id, role, name, consent_code, created_at, updated_at)
       VALUES (?, ?, ?, 'human', ?, ?, ?, ?)`,
    )
    .run("seat-raceway-human", userId, "raceway", "Operator human seat", "consent-raceway-human", seatNow, seatNow);
  await db
    .prepare(
      `INSERT INTO oauth_seats (id, user_id, project_id, role, name, consent_code, created_at, updated_at)
       VALUES (?, ?, ?, 'coder', ?, ?, ?, ?)`,
    )
    .run("seat-raceway-coder", userId, "raceway", "Operator coder seat", "consent-raceway-coder", seatNow, seatNow);
  await db.prepare("INSERT INTO orgs (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").run("factory-org", "Factory Org", userId, Date.now());
  await db.prepare("UPDATE orgs SET plan = ?, seat_quantity = ?, billing_status = ? WHERE id = ?").run("team", 50, "active", "factory-org");
  // MCP tools fail closed without org BYOK when projects.org_id is set. Seed a
  // decryptable default key so claim/status paths match a paid customer org.
  const providerSecret = "sk-browser-fixture-openrouter-key";
  const enc = encryptSecret(providerSecret, secretsEnv);
  const providerKeyId = randomUUID();
  const keyNow = Date.now();
  await db
    .prepare(
      `INSERT INTO org_provider_keys
         (id, org_id, label, ciphertext, iv, tag, last4, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      providerKeyId,
      "factory-org",
      "fixture",
      enc.ciphertext,
      enc.iv,
      enc.tag,
      enc.last4,
      userId,
      keyNow,
    );
  await db
    .prepare("UPDATE orgs SET default_provider_key_id = ? WHERE id = ?")
    .run(providerKeyId, "factory-org");
  await db.prepare("UPDATE projects SET org_id = ? WHERE id IN (?, ?)").run("factory-org", "raceway", "empty");
  const imageBlobs = new BrowserImageBlobStore();
  const made = createApp(db, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 60_000 },
    imageBlobStore: imageBlobs,
  });
  queueRef = made.queue;
  stopWorker = () => made.worker.stop();
  const activeId = await made.queue.submit("raceway", "Operator", { title: "Unwedge merge queue", body: "Outcome: Restore merge dispatch after stale checks block active work.\nEvidence: raw queue diagnostics", evidence: [] });
  activeTaskId = activeId;
  // submit() mints a root with task_id backfilled. This fixture replaces that
  // root with a hand-built timeline; detach the auto root so activity groups
  // stay at the two sessions the assertions expect (timeline root + review).
  const autoRootId = (
    (await db
      .prepare("SELECT root_thread_id FROM tasks WHERE id = ?")
      .get<{ root_thread_id: number }>(activeId)) as { root_thread_id: number }
  ).root_thread_id;
  await db.prepare("UPDATE threads SET task_id = NULL WHERE id = ?").run(autoRootId);
  await new ImageAttachmentService(db, imageBlobs).attach({
    projectId: "raceway",
    taskId: activeId,
    mimeType: "image/png",
    caption: "Merge queue failure reference",
    bytes: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXcAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const timelineStart = Date.now();
  await db.prepare("INSERT INTO threads (project_id, kind, task_id, created_at) VALUES (?, 'submission', ?, ?)").run("raceway", activeId, timelineStart);
  const threadId = (await db.prepare("SELECT id FROM threads WHERE project_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1").get<{ id: number }>("raceway", activeId))!.id;
  timelineRootThreadId = threadId;
  await db.prepare("UPDATE tasks SET root_thread_id = ? WHERE id = ?").run(threadId, activeId);
  await db.prepare("INSERT INTO session_events (project_id, session_id, thread_id, task_id, seq, type, role, author, content, start_time, end_time) VALUES (?, ?, ?, ?, 1, 'request', 'human', 'Operator', ?, ?, ?)").run("raceway", threadId, threadId, activeId, "Please unwedge the queue", timelineStart, timelineStart + 1);
  const requestId = (await db.prepare("SELECT id FROM session_events WHERE session_id = ? AND seq = 1").get<{ id: number }>(threadId))!.id;
  await db.prepare("INSERT INTO session_events (project_id, session_id, parent_id, thread_id, task_id, seq, type, role, author, content, start_time, end_time) VALUES (?, ?, ?, ?, ?, 2, 'reasoning', 'mediator', 'steward', ?, ?, ?)").run("raceway", threadId, requestId, threadId, activeId, "The queue is blocked behind a stale speculative build.", timelineStart + 10, timelineStart + 11);
  const reasoningId = (await db.prepare("SELECT id FROM session_events WHERE session_id = ? AND seq = 2").get<{ id: number }>(threadId))!.id;
  await db.prepare("INSERT INTO session_events (project_id, session_id, parent_id, thread_id, task_id, seq, type, role, author, content, start_time, end_time) VALUES (?, ?, ?, ?, ?, 3, 'text', 'mediator', 'steward', ?, ?, ?)").run("raceway", threadId, reasoningId, threadId, activeId, "Plan approved", timelineStart + 20, timelineStart + 21);
  const approvalId = (await db.prepare("SELECT id FROM session_events WHERE session_id = ? AND seq = 3").get<{ id: number }>(threadId))!.id;
  await db.prepare("INSERT INTO threads (project_id, kind, task_id, root_id, created_at) VALUES (?, 'review', ?, ?, ?)").run("raceway", activeId, threadId, timelineStart + 25);
  timelineChildThreadId = (await db.prepare("SELECT id FROM threads WHERE project_id = ? AND task_id = ? AND root_id = ? ORDER BY id DESC LIMIT 1").get<{ id: number }>("raceway", activeId, threadId))!.id;
  await db.prepare("INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (?, 'human', 'Operator', ?, ?)").run(threadId, "Please unwedge the queue", timelineStart);
  await db.prepare("INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (?, 'coder', 'codex', ?, ?)").run(timelineChildThreadId, "Implement the approved recovery", timelineStart + 30);
  await db.prepare("INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (?, 'mediator', 'steward', ?, ?)").run(timelineChildThreadId, JSON.stringify({ verdict: "approved", feedback: "", rationale: "The recovery plan preserves queue ordering." }), timelineStart + 31);
  await db.prepare("INSERT INTO session_events (project_id, session_id, parent_id, thread_id, task_id, seq, type, role, author, content, start_time, end_time) VALUES (?, ?, ?, ?, ?, 4, 'request', 'coder', 'codex', ?, ?, ?)").run("raceway", threadId, approvalId, timelineChildThreadId, activeId, "Implement the approved recovery", timelineStart + 3_000, timelineStart + 3_001);
  const coderId = (await db.prepare("SELECT id FROM session_events WHERE session_id = ? AND seq = 4").get<{ id: number }>(threadId))!.id;
  const recoveryId = (await db.prepare("INSERT INTO session_events (project_id, session_id, parent_id, thread_id, task_id, seq, type, role, author, content, start_time, end_time) VALUES (?, ?, ?, ?, ?, 5, 'verdict', 'mediator', 'steward', ?, ?, ?) RETURNING id").get<{ id: number }>("raceway", threadId, coderId, timelineChildThreadId, activeId, JSON.stringify({ verdict: "approved", feedback: "**Recovery verified**\n\n- stale build stopped\n- queue resumed\n\n| check | state |\n| --- | --- |\n| dispatch | `ready` |", rationale: "The recovery plan preserves queue ordering." }), timelineStart + 3_010, timelineStart + 3_011))!.id;
  await db.prepare("INSERT INTO session_events (project_id, session_id, parent_id, thread_id, task_id, seq, type, role, author, content, start_time, end_time) VALUES (?, ?, ?, ?, ?, 6, 'tool_call', 'coder', 'codex', ?, ?, NULL)").run("raceway", threadId, recoveryId, timelineChildThreadId, activeId, JSON.stringify({ action: "verify_recovery" }), timelineStart + 5_000);
  const recoveryDecision = await db.prepare("INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES (?, ?, 'approve', ?, ?, ?) RETURNING id").get<{ id: number }>("raceway", activeId, "Recovery plan approved", "The stale build was proven inactive.", timelineStart + 15);
  await db.prepare("INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("raceway", "operations/merge-queue.md", "Learning", "Merge queue recovery", "How to recover dispatch", JSON.stringify(["queue", "ci"]), "Reset a stale queue entry after proving no merge-group dispatch.", Date.now());
  await db.prepare("INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("raceway", "conventions/prove-inactive.md", "Convention", "Prove inactive work", "Verify a stale run before replacing it", JSON.stringify(["queue", "safety"]), "A stale run must be proven inactive before replacement.", Date.now());
  await db.prepare("INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("raceway", "tech/runtime/worker-jobs.md", "Architecture", "Worker jobs", "How background jobs execute", JSON.stringify(["runtime"]), "Workers execute durable project jobs.", Date.now());
  await db.prepare("INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("raceway", "decisions/product-framing.md", "Decision", "Product framing", "What the product is", JSON.stringify(["product"]), "---\\ntitle: Leaked fixture metadata\\ntags: [product]\\n---\\n# Operating model\\n\\nThe dashboard is an **operational surface**.\\n\\n- Inspect [merge recovery](../operations/merge-queue.md#recovery).\\n- Ignore [missing runbook](../operations/missing.md#recovery).\\n- Read the [external release](https://example.com/release).\\n\\n| signal | owner |\\n| --- | --- |\\n| queue | operator |\\n\\n```sh\\npnpm test\\n```", Date.now());
  await db.prepare("INSERT INTO memory_log (project_id, task_id, entry, created_at) VALUES (?, ?, ?, ?)").run("raceway", activeId, `curated@${recoveryDecision!.id}: operations/merge-queue.md`, timelineStart + 16);
  await db.prepare("INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES (?, ?, 'revise', ?, ?, ?)").run("raceway", activeId, "Require proof before replacement", "Enforced conventions/prove-inactive.md", timelineStart + 17);
  await db.prepare("INSERT INTO memory_log (project_id, task_id, entry, created_at) VALUES (?, ?, ?, ?)").run("raceway", activeId, "Updated knowledge: conventions/prove-inactive.md", timelineStart + 18);
  await made.queue.submit("raceway", "Operator", { title: "Rebase claimed work", body: "", evidence: [] });
  const blockedId = await made.queue.submit("raceway", "Operator", { title: "Repair failed CI", body: "", evidence: [] });
  blockedTaskId = blockedId;
  await made.queue.claimNext("raceway", "codex-home", DEFAULT_LEASE_TTL_MS);
  await db.prepare("UPDATE tasks SET plan = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?").run(
    "Preserve queue ordering while replacing the stale dispatch.",
    Date.now() + 120_000,
    Date.now(),
    activeId,
  );
  await db.prepare("UPDATE tasks SET state = 'BLOCKED', updated_at = ? WHERE id = ?").run(Date.now(), blockedId);
  await db.prepare("INSERT INTO questions (project_id, task_id, asked_by, question, created_at) VALUES (?, ?, ?, ?, ?)").run("raceway", blockedId, "mediator", "Should this retry wait for the failing check?", Date.now());
  await db.prepare("INSERT INTO questions (project_id, task_id, asked_by, question, answer, status, created_at) VALUES (?, ?, ?, ?, ?, 'answered', ?)").run("raceway", blockedId, "mediator", "Which retry path?", "Wait for the check", Date.now());
  await db.prepare("INSERT INTO questions (project_id, task_id, asked_by, question, created_at) VALUES (?, ?, ?, ?, ?)").run("raceway", blockedId, "mediator", "Resolved: wait for the failing check.", Date.now());
  doneTaskId = (await db.prepare(
    `INSERT INTO tasks (project_id, title, body, priority, state, submitted_by, created_at, updated_at)
     VALUES (?, ?, '', 2, 'DONE', ?, ?, ?) RETURNING id`,
  ).get<{ id: number }>("raceway", "Archive completed rollout", "Operator", Date.now(), Date.now()))!.id;
  await db.prepare(
    `INSERT INTO tasks (project_id, title, body, priority, state, hold_cause, submitted_by, created_at, updated_at)
     VALUES (?, ?, '', 2, 'HELD', 'explicit', ?, ?, ?)`,
  ).run("raceway", "Deliberately parked rollout", "Operator", Date.now(), Date.now());
  await db.prepare(
    `INSERT INTO tasks (project_id, title, body, priority, state, incubate_until, submitted_by, created_at, updated_at)
     VALUES (?, ?, '', 2, 'INCUBATING', ?, ?, ?, ?)`,
  ).run("raceway", "Warming consent gate", Date.now() + 3_600_000, "Operator", Date.now(), Date.now());
  // Frigg analytics fixtures: stacked scorecard + sub-cent routing spend.
  // Mixed families + unattributed, with inverted completion counts across kinds
  // so completions-desc would reorder segments while family-rank order stays fixed.
  const analyticsNow = Date.now();
  const groomJob = (await db.prepare(
    "INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'groom', '{}', 'done', ?, ?) RETURNING id",
  ).get<{ id: number }>("raceway", analyticsNow, analyticsNow))!;
  await db.prepare(
    "INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'groom', ?, ?, ?, ?)",
  ).run(groomJob.id, "raceway", "glm-5.2", 6.43, 47, analyticsNow);
  const flashJob = (await db.prepare(
    "INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'groom', '{}', 'done', ?, ?) RETURNING id",
  ).get<{ id: number }>("raceway", analyticsNow, analyticsNow))!;
  await db.prepare(
    "INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'groom', ?, ?, ?, ?)",
  ).run(flashJob.id, "raceway", "gemini-3.1-flash-lite", 0.004, 5, analyticsNow);
  const otherJob = (await db.prepare(
    "INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'groom', '{}', 'done', ?, ?) RETURNING id",
  ).get<{ id: number }>("raceway", analyticsNow, analyticsNow))!;
  await db.prepare(
    "INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'groom', ?, ?, ?, ?)",
  ).run(otherJob.id, "raceway", "claude-sonnet-4", 0.5, 3, analyticsNow);
  const unknownGroom = (await db.prepare(
    "INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'groom', '{}', 'done', ?, ?) RETURNING id",
  ).get<{ id: number }>("raceway", analyticsNow, analyticsNow))!;
  await db.prepare(
    "INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'groom', NULL, ?, ?, ?)",
  ).run(unknownGroom.id, "raceway", 0.01, 2, analyticsNow);
  // refresh kind: unattributed dominates, gemini is small — completions-desc would flip order.
  const refreshUnknown = (await db.prepare(
    "INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'refresh', '{}', 'done', ?, ?) RETURNING id",
  ).get<{ id: number }>("raceway", analyticsNow, analyticsNow))!;
  await db.prepare(
    "INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'refresh', NULL, ?, ?, ?)",
  ).run(refreshUnknown.id, "raceway", 0.02, 40, analyticsNow);
  const refreshGemini = (await db.prepare(
    "INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'refresh', '{}', 'done', ?, ?) RETURNING id",
  ).get<{ id: number }>("raceway", analyticsNow, analyticsNow))!;
  await db.prepare(
    "INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'refresh', ?, ?, ?, ?)",
  ).run(refreshGemini.id, "raceway", "gemini-3.1-flash-lite", 0.003, 1, analyticsNow);
  const refreshOther = (await db.prepare(
    "INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'refresh', '{}', 'done', ?, ?) RETURNING id",
  ).get<{ id: number }>("raceway", analyticsNow, analyticsNow))!;
  await db.prepare(
    "INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'refresh', ?, ?, ?, ?)",
  ).run(refreshOther.id, "raceway", "claude-sonnet-4", 0.2, 10, analyticsNow);
  await db.prepare(
    "INSERT INTO job_policy_log (project_id, job_id, attempt, invocation, kind, model, effort, max_tokens, rollout_arm, latency_ms, outcome, started_at, finished_at, created_at, updated_at) VALUES (?, ?, 1, 1, 'groom', 'glm-5.2', 'high', 1000, 'routed', 1200, 'ok', ?, ?, ?, ?)",
  ).run("raceway", groomJob.id, analyticsNow - 1200, analyticsNow, analyticsNow, analyticsNow);
  await db.prepare(
    "INSERT INTO job_policy_log (project_id, job_id, attempt, invocation, kind, model, effort, max_tokens, rollout_arm, latency_ms, outcome, started_at, finished_at, created_at, updated_at) VALUES (?, ?, 1, 1, 'groom', 'gemini-3.1-flash-lite', 'low', 1000, 'routed', 400, 'ok', ?, ?, ?, ?)",
  ).run("raceway", flashJob.id, analyticsNow - 400, analyticsNow, analyticsNow, analyticsNow);
  expect(activeId).toBeGreaterThan(0);
  await new Promise<void>((resolve) => { server = made.app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  page = await context.newPage();
  await page.goto(`${baseUrl}/signin`);
  await page.locator("#email").fill(EMAIL);
  await page.locator("#submit").click();
  const operatorMagicLink = new URL(latestMagicLink(EMAIL));
  const local = new URL(baseUrl);
  operatorMagicLink.protocol = local.protocol;
  operatorMagicLink.host = local.host;
  await page.goto(operatorMagicLink.toString());
  await page.locator(".dashboard-shell").waitFor({ state: "visible" });
});

afterAll(async () => {
  if (context) await context.close();
  if (browser) await browser.close();
  stopWorker?.();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("React operational home in a real browser", () => {
  async function seriousAccessibilityViolations() {
    const requiredRules = new Set(["page-has-heading-one", "heading-order", "button-name", "link-name", "aria-allowed-attr"]);
    const result = await new AxeBuilder({ page }).analyze();
    return result.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical" || requiredRules.has(violation.id))
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target.join(" ")),
      }));
  }

  async function knowledgeAccessibilityViolations() {
    const result = await new AxeBuilder({ page }).include(".knowledge-view").analyze();
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
  }

  async function chooseSelect(label: string, option: string) {
    // Sidebar + account menu can both expose project pickers; pin the sidebar control.
    if (label === "Project") {
      await page.locator("#project-select").click();
    } else {
      await page.getByRole("combobox", { name: label }).click();
    }
    await page.getByRole("option", { name: option, exact: true }).click();
  }

  async function connectCoder(token: string): Promise<Client> {
    const client = new Client({ name: "dashboard-browser-test", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    return client;
  }

  function parseTool(result: { content?: unknown }): Record<string, unknown> {
    const content = result.content as { type: string; text: string }[];
    return JSON.parse(content[0].text) as Record<string, unknown>;
  }

  async function expectPopulatedTimeline(scope = page.locator(".feed-timeline")) {
    await scope.locator('.aui-msg[data-event-id]').first().waitFor();
    expect(new Set(await scope.locator(".aui-msg[data-actor]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-actor"))))).toEqual(new Set(["human", "mediator", "coder"]));
    expect(await scope.locator("details.aui-reasoning").count()).toBeGreaterThan(0);
    expect(await scope.locator('[data-timeline-row="decision"]').count()).toBeGreaterThan(0);
    expect(await scope.locator('[data-timeline-row="cross-thread"]').count()).toBeGreaterThan(0);
    expect(await scope.locator('.aui-event-row [data-actor-role]').count()).toBeGreaterThan(1);
    const order = await scope.locator("[data-timeline-order]").evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("data-timeline-order"))));
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(await scope.locator(".aui-empty").count()).toBe(0);
  }

  it("persists System, Light, and Dark before paint across the dashboard shell", async () => {
    const themePage = await context.newPage();
    const colors = async () => themePage.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        scheme: root.colorScheme,
        background: root.getPropertyValue("--bg").trim(),
        text: root.getPropertyValue("--text").trim(),
      };
    });
    const openThemeMenu = async () => {
      const details = themePage.locator(".account-menu");
      if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click();
    };
    const dashboardUrl = `${baseUrl}/dashboard/?project=raceway&view=dashboard&thread=${timelineRootThreadId}`;
    try {
      await themePage.goto(dashboardUrl);
      await themePage.locator(".dashboard-shell").waitFor();
      await themePage.evaluate(() => window.localStorage.clear());

      await themePage.emulateMedia({ colorScheme: "light" });
      await themePage.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
      expect(await themePage.locator("html").getAttribute("data-theme")).toBeNull();
      await themePage.locator(".dashboard-shell").waitFor();
      await openThemeMenu();
      expect(await themePage.getByRole("radio", { name: "System" }).isChecked()).toBe(true);
      expect(await colors()).toEqual({ scheme: "light", background: "#f7f9fb", text: "#25313c" });
      if (process.env.DASHBOARD_SCREENSHOTS) {
        await themePage.screenshot({ path: "/tmp/memracer-task-307-light-1440.png", fullPage: true });
      }

      await themePage.emulateMedia({ colorScheme: "dark" });
      await expect.poll(colors).toEqual({ scheme: "dark", background: "#07080b", text: "#b2bbc6" });

      await themePage.evaluate(() => window.localStorage.setItem("memracer.react.theme", "light"));
      await themePage.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
      expect(await themePage.locator("html").getAttribute("data-theme")).toBe("light");
      await themePage.locator(".dashboard-shell").waitFor();
      await openThemeMenu();
      expect(await themePage.getByRole("radio", { name: "Light" }).isChecked()).toBe(true);
      expect(await colors()).toEqual({ scheme: "light", background: "#f7f9fb", text: "#25313c" });

      await themePage.getByRole("button", { name: "Settings", exact: true }).focus();
      // Account menu order: Settings → Help/FAQ → theme radios.
      await themePage.keyboard.press("Tab");
      await themePage.keyboard.press("Tab");
      expect(await themePage.evaluate(() => document.activeElement?.id)).toBe("theme-light");
      const focusRing = await themePage.locator("#theme-light + span").evaluate((element) => {
        const style = getComputedStyle(element);
        return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
      });
      expect(focusRing.style).toBe("solid");
      expect(focusRing.width).toBeGreaterThan(0);

      await themePage.emulateMedia({ colorScheme: "light" });
      await themePage.locator('label[for="theme-dark"]').click();
      expect(await themePage.locator("html").getAttribute("data-theme")).toBe("dark");
      expect(await themePage.evaluate(() => window.localStorage.getItem("memracer.react.theme"))).toBe("dark");
      expect(await colors()).toEqual({ scheme: "dark", background: "#07080b", text: "#b2bbc6" });

      await themePage.reload({ waitUntil: "domcontentloaded" });
      expect(await themePage.locator("html").getAttribute("data-theme")).toBe("dark");
      await themePage.locator(".dashboard-shell").waitFor();
      await openThemeMenu();
      expect(await themePage.getByRole("radio", { name: "Dark" }).isChecked()).toBe(true);
      await themePage.emulateMedia({ colorScheme: "dark" });
      expect(await colors()).toEqual({ scheme: "dark", background: "#07080b", text: "#b2bbc6" });

      await themePage.locator('label[for="theme-light"]').click();
      expect(await themePage.locator("html").getAttribute("data-theme")).toBe("light");
      expect(await themePage.evaluate(() => window.localStorage.getItem("memracer.react.theme"))).toBe("light");
      await themePage.reload({ waitUntil: "domcontentloaded" });
      expect(await themePage.locator("html").getAttribute("data-theme")).toBe("light");
      await themePage.locator(".dashboard-shell").waitFor();
      await openThemeMenu();
      expect(await themePage.getByRole("radio", { name: "Light" }).isChecked()).toBe(true);
      expect(await colors()).toEqual({ scheme: "light", background: "#f7f9fb", text: "#25313c" });

      await themePage.locator('label[for="theme-system"]').click();
      expect(await themePage.locator("html").getAttribute("data-theme")).toBeNull();
      expect(await themePage.evaluate(() => window.localStorage.getItem("memracer.react.theme"))).toBe("system");
      expect(await colors()).toEqual({ scheme: "dark", background: "#07080b", text: "#b2bbc6" });

      await themePage.reload({ waitUntil: "domcontentloaded" });
      expect(await themePage.locator("html").getAttribute("data-theme")).toBeNull();
      await themePage.locator(".dashboard-shell").waitFor();
      await openThemeMenu();
      expect(await themePage.getByRole("radio", { name: "System" }).isChecked()).toBe(true);
      await themePage.emulateMedia({ colorScheme: "light" });
      await expect.poll(colors).toEqual({ scheme: "light", background: "#f7f9fb", text: "#25313c" });
      await themePage.emulateMedia({ colorScheme: "dark" });
      await expect.poll(colors).toEqual({ scheme: "dark", background: "#07080b", text: "#b2bbc6" });

      const desktopFit = await themePage.locator(".account-menu-popover").evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
      expect(desktopFit.scroll).toBeLessThanOrEqual(desktopFit.client);
      await themePage.setViewportSize({ width: 375, height: 812 });
      await themePage.getByRole("button", { name: "Open navigation" }).click();
      const mobileFit = await themePage.locator(".account-menu-popover").evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return { client: element.clientWidth, scroll: element.scrollWidth, left: bounds.left, right: bounds.right, viewport: window.innerWidth };
      });
      expect(mobileFit.scroll).toBeLessThanOrEqual(mobileFit.client);
      expect(mobileFit.left).toBeGreaterThanOrEqual(0);
      expect(mobileFit.right).toBeLessThanOrEqual(mobileFit.viewport);
      if (process.env.DASHBOARD_SCREENSHOTS) {
        await themePage.screenshot({ path: "/tmp/memracer-task-307-dark-1440.png", fullPage: true });
        await themePage.screenshot({ path: "/tmp/memracer-task-307-dark-375.png", fullPage: true });
      }
    } finally {
      await themePage.evaluate(() => window.localStorage.removeItem("memracer.react.theme")).catch(() => undefined);
      await themePage.close();
    }
  }, 60_000);

  it("self-hosts the design-system fonts and applies semantic type and state roles", async () => {
    const designPage = await context.newPage();
    const fontRequests: string[] = [];
    designPage.on("request", (request) => {
      if (request.resourceType() === "font") fontRequests.push(request.url());
    });
    try {
      await designPage.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard`);
      await designPage.locator(".dashboard-shell").waitFor();
      await designPage.evaluate(() => document.fonts.ready);

      const roles = await designPage.evaluate(() => {
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        return {
          body: style("body").fontFamily,
          kpi: style(".status-value").fontFamily,
          actor: style(".actor-attribution b").fontFamily,
          executingBackground: style('.state-chip[data-state="EXECUTING"]').backgroundColor,
          claimedBackground: style('.state-chip[data-state="CLAIMED"]').backgroundColor,
        };
      });
      expect(roles.body).toContain("Space Grotesk");
      expect(roles.actor).toContain("Space Grotesk");
      expect(roles.kpi).toContain("JetBrains Mono");
      expect(roles.executingBackground).toBe("rgb(226, 243, 251)");
      expect(roles.claimedBackground).toBe("rgba(0, 0, 0, 0)");
      expect(fontRequests.length).toBeGreaterThan(0);
      expect(fontRequests.every((url) => new URL(url).origin === new URL(baseUrl).origin)).toBe(true);

      if (process.env.DASHBOARD_SCREENSHOTS) {
        await designPage.screenshot({ path: "/tmp/memracer-task-219-after-operations.png", fullPage: true });
        await designPage.setViewportSize({ width: 375, height: 812 });
        await designPage.screenshot({ path: "/tmp/memracer-task-219-after-phone.png", fullPage: true });
      }
    } finally {
      await designPage.close();
    }
  });

  it("renders a coder-last tool call while the recording is still live", async () => {
    const livePage = await context.newPage();
    try {
      await livePage.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      class DelayedSessionEventSource {
        static readonly CONNECTING = NativeEventSource.CONNECTING;
        static readonly OPEN = NativeEventSource.OPEN;
        static readonly CLOSED = NativeEventSource.CLOSED;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        private readonly source: EventSource;
        private readonly delayTerminal: boolean;
        constructor(url: string | URL, options?: EventSourceInit) {
          this.delayTerminal = String(url).includes("/sessions/");
          this.source = new NativeEventSource(url, options);
          this.source.onopen = (event) => this.onopen?.(event);
          this.source.onmessage = (event) => {
            const terminal = event.data === "[DONE]" || event.data.includes('"type":"finish"');
            if (this.delayTerminal && terminal) window.setTimeout(() => this.onmessage?.(event), 500);
            else this.onmessage?.(event);
          };
          this.source.onerror = (event) => {
            if (this.delayTerminal) window.setTimeout(() => this.onerror?.(event), 500);
            else this.onerror?.(event);
          };
        }
        get readyState() { return this.source.readyState; }
        get url() { return this.source.url; }
        get withCredentials() { return this.source.withCredentials; }
        addEventListener(...args: Parameters<EventSource["addEventListener"]>) { return this.source.addEventListener(...args); }
        removeEventListener(...args: Parameters<EventSource["removeEventListener"]>) { return this.source.removeEventListener(...args); }
        dispatchEvent(event: Event) { return this.source.dispatchEvent(event); }
        close() { this.source.close(); }
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: DelayedSessionEventSource });
      });
      await livePage.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&thread=${timelineRootThreadId}`);
      const coderTool = livePage.locator('.feed-timeline .aui-msg[data-actor="coder"]').last();
      await coderTool.waitFor();
      expect(await coderTool.getAttribute("data-message-status")).toBe("running");
      expect(await livePage.locator(".feed-timeline .boundary-error").count()).toBe(0);
    } finally {
      await livePage.close();
    }
  });

  it("renders the chronological transcript from feed clicks and thread/task deep links", async () => {
    const pageErrors: Error[] = [];
    let siblingRequests = 0;
    const onPageError = (error: Error) => pageErrors.push(error);
    page.on("pageerror", onPageError);
    page.on("request", (request) => {
      if (request.url().includes("/siblings?thread=")) siblingRequests += 1;
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&thread=${timelineRootThreadId}`);
    await expectPopulatedTimeline();
    expect(siblingRequests).toBe(1);
    expect(await page.locator(".feed-timeline .boundary-error").count()).toBe(0);
    expect(await page.locator(".feed-timeline .aui-msg").last().getAttribute("data-actor")).toBe("coder");
    expect(await page.locator(".feed-timeline .aui-msg[data-timeline-order]").count()).toBeGreaterThan(0);
    expect(await page.getByRole("region", { name: "Session replay controls" }).count()).toBe(0);
    expect(await page.locator('[aria-label="Causal session graph"]').count()).toBe(0);
    expect(await page.locator(".feed-timeline .aui-msg[data-timeline-order]").count()).toBeGreaterThan(1);
    expect(await page.locator(".feed-timeline [data-legend-glyph]").count()).toBe(0);
    expect(await page.locator(".feed-timeline .aui-step, .feed-timeline .aui-live").count()).toBe(0);
    if (process.env.DASHBOARD_SCREENSHOTS) {
      const phase = process.env.DASHBOARD_SCREENSHOT_PHASE ?? "after";
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      await page.locator(".feed-surface").screenshot({ path: `/tmp/memracer-task-344-${phase}-light-1440.png` });
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await page.locator(".feed-surface").screenshot({ path: `/tmp/memracer-task-344-${phase}-dark-1440.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("navigation", { name: "Mobile views" }).getByRole("button", { name: "Activity" }).click();
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      await page.locator(".feed-surface").screenshot({ path: `/tmp/memracer-task-344-${phase}-light-390.png` });
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await page.locator(".feed-surface").screenshot({ path: `/tmp/memracer-task-344-${phase}-dark-390.png` });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    expect(pageErrors).toEqual([]);
    const collapsedTaskRow = page.locator(`[data-thread-id="${timelineChildThreadId}"]`);
    expect(await collapsedTaskRow.textContent()).toContain("2 sessions");
    expect(await collapsedTaskRow.getAttribute("class")).toContain("active");
    expect(await collapsedTaskRow.locator('.state-chip[data-state="CLAIMED"]').count()).toBe(1);
    expect(await collapsedTaskRow.locator('.ui-actor-label[data-actor-role="mediator"] b').textContent()).toBe("Frigg");
    await collapsedTaskRow.locator('.ui-actor-label[data-actor-role="mediator"]').hover();
    await page.getByRole("tooltip", { name: "Frigg" }).waitFor();
    expect(await page.locator(`[data-thread-id="${timelineRootThreadId}"]`).count()).toBe(0);
    expect(new URL(page.url()).searchParams.get("thread")).toBe(String(timelineRootThreadId));

    await collapsedTaskRow.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("thread")).toBe(String(timelineChildThreadId));
    await expectPopulatedTimeline();
    const mediatorLabels = await page.locator('.feed-timeline [data-actor-role="mediator"] b').allTextContents();
    expect(mediatorLabels.length).toBeGreaterThan(0);
    expect(mediatorLabels.every((label) => label === "Frigg")).toBe(true);
    if (process.env.DASHBOARD_SCREENSHOTS) await page.locator(".feed-surface").screenshot({ path: "/tmp/memracer-task-256-frigg-dashboard.png" });
    const timelineBody = page.locator(".feed-timeline .aui-md").first();
    const timelineTypography = await timelineBody.evaluate((node) => {
      const style = getComputedStyle(node);
      const card = node.closest(".aui-msg-card");
      return {
        fontFamily: style.fontFamily,
        maxWidth: style.maxWidth,
        cardMaxWidth: card ? getComputedStyle(card).maxWidth : "",
      };
    });
    expect(timelineTypography.fontFamily).toMatch(/system-ui|sans-serif/i);
    // Reading measure lives on the card shell; prose fills it (max-width 100%).
    expect(timelineTypography.cardMaxWidth).not.toBe("none");
    expect(timelineTypography.cardMaxWidth).not.toBe("");
    expect(timelineTypography.maxWidth).not.toBe("none");
    const verdict = page.locator(".feed-timeline .aui-text-body").filter({ has: page.locator(".aui-verdict") });
    expect(await verdict.getByText("approved", { exact: true }).count()).toBeGreaterThan(0);
    expect(await verdict.locator("strong").filter({ hasText: "Recovery verified" }).count()).toBe(1);
    expect(await verdict.locator("li").allTextContents()).toEqual(["stale build stopped", "queue resumed"]);
    expect(await verdict.locator("table").textContent()).toContain("dispatch");
    expect(await verdict.locator("code").textContent()).toBe("ready");
    expect(await page.locator(".feed-surface select").count()).toBe(0);
    expect(await page.locator(".feed-surface pre").count()).toBe(0);
    expect(await page.locator(".feed-timeline .aui-tool-payload code").count()).toBeGreaterThan(0);
    expect(await page.locator(".feed-timeline .aui-cross-thread").textContent()).not.toMatch(/\*\*|\|\s*---/);
    expect(await page.locator(".feed-surface [data-identity-key]:not(.ui-avatar)").count()).toBe(0);
    expect(await page.locator('.feed-timeline-heading .state-chip[data-state="CLAIMED"]').count()).toBe(1);
    const desktopActivityGeometry = await page.locator(".feed-surface").evaluate((surface) => {
      const surfaceBox = surface.getBoundingClientRect();
      return [...surface.querySelectorAll<HTMLElement>(".aui-msg-card")].every((card) => {
        const box = card.getBoundingClientRect();
        return box.left >= surfaceBox.left && box.right <= surfaceBox.right + 1;
      });
    });
    expect(desktopActivityGeometry).toBe(true);
    if (process.env.DASHBOARD_SCREENSHOTS) await verdict.screenshot({ path: "/tmp/memracer-task-207-verdict-desktop.png" });
    const activitySurface = page.locator(".feed-surface");
    await activitySurface.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -80));
    const threadList = activitySurface.getByRole("navigation", { name: "Project threads" });
    await threadList.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const beforeThreadListWheel = await page.evaluate(() => window.scrollY);
    await threadList.hover();
    await page.mouse.wheel(0, 320);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeThreadListWheel);
    await activitySurface.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -80));
    const transcriptViewport = activitySurface.locator(".aui-viewport");
    const transcriptBoundary = await transcriptViewport.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return {
        atBottom: node.scrollTop >= node.scrollHeight - node.clientHeight - 1,
        overscroll: getComputedStyle(node).overscrollBehaviorY,
      };
    });
    expect(transcriptBoundary).toEqual({ atBottom: true, overscroll: "auto" });
    if (process.env.DASHBOARD_SCREENSHOTS) {
      await page.locator(".feed-surface").screenshot({ path: "/tmp/memracer-task-334-transcript.png" });
      await page.locator(".feed-surface").screenshot({ path: "/tmp/memracer-task-167-after-activity.png" });
      await page.screenshot({ path: "/tmp/memracer-task-232-after-1440.png", fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("navigation", { name: "Mobile views" }).getByRole("button", { name: "Activity" }).click();
    await page.locator(".feed-surface").waitFor({ state: "visible" });
    expect(await verdict.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.locator(".feed-surface").evaluate((surface) => surface.scrollWidth <= surface.clientWidth)).toBe(true);
    expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= window.innerWidth)).toBe(true);
    expect(await page.locator(".feed-timeline .aui-trace-scroll").count()).toBe(0);
    expect(await page.getByRole("region", { name: "Session replay controls" }).count()).toBe(0);
    expect((await page.locator('.feed-surface nav[aria-label="Project threads"]').boundingBox())!.height).toBeLessThan(180);
    if (process.env.DASHBOARD_SCREENSHOTS) {
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      await page.locator(".feed-surface").screenshot({ path: "/tmp/memracer-task-334-after-light-390.png" });
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await page.locator(".feed-surface").screenshot({ path: "/tmp/memracer-task-334-after-dark-390.png" });
      await verdict.screenshot({ path: "/tmp/memracer-task-207-verdict-mobile.png" });
      await page.screenshot({ path: "/tmp/memracer-task-232-after-390.png", fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&thread=${timelineChildThreadId}`);
    await expectPopulatedTimeline();

    await dbRef.prepare("INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (?, ?, 'lease_expired', ?, ?)")
      .run(activeTaskId, "codex-old", "lease expired after recovery grace; task requeued", Date.now());
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&task=${activeTaskId}&thread=${timelineChildThreadId}`);
    await page.locator(".task-sheet").waitFor();
    await expectPopulatedTimeline(page.locator(".task-timeline"));
    // Task #490: on a wide sheet, message cards and decision nodes must share one
    // content measure — no multi-hundred-px right-edge mismatch / left-shifted dead band.
    await page.setViewportSize({ width: 1440, height: 1000 });
    const taskTimelineWidthConsistency = await page.locator(".task-timeline").evaluate((scope) => {
      const nodes = [...scope.querySelectorAll<HTMLElement>(".aui-msg-card, .aui-decision")];
      if (nodes.length < 2) {
        return { ok: false as const, reason: `need ≥2 measured nodes, got ${nodes.length}` };
      }
      const boxes = nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { width: box.width, right: box.right, maxWidth: getComputedStyle(node).maxWidth };
      });
      const rights = boxes.map((b) => b.right);
      const widths = boxes.map((b) => b.width);
      const rightSpread = Math.max(...rights) - Math.min(...rights);
      const widthSpread = Math.max(...widths) - Math.min(...widths);
      const allMeasured = boxes.every((b) => b.maxWidth !== "none" && b.maxWidth !== "");
      return {
        ok: allMeasured && rightSpread <= 12 && widthSpread <= 12,
        rightSpread,
        widthSpread,
        allMeasured,
        boxes,
        count: nodes.length,
      };
    });
    expect(taskTimelineWidthConsistency.ok, JSON.stringify(taskTimelineWidthConsistency)).toBe(true);
    await page.getByRole("tab", { name: /Attempts/ }).click();
    expect(await page.locator(".attempt-row").filter({ hasText: "lease expired" }).textContent()).toContain("task requeued");
    page.off("pageerror", onPageError);
  }, 60_000);

  it("guards Knowledge decisions that have no linked concept", async () => {
    const pageErrors: Error[] = [];
    const onPageError = (error: Error) => pageErrors.push(error);
    page.on("pageerror", onPageError);
    await page.route("**/api/p/raceway/knowledge/activity", async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { decisions: Array<{ concepts: unknown[] }> };
      expect(body.decisions.length).toBeGreaterThan(0);
      body.decisions[0].concepts = [];
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=knowledge`);
    const decisions = page.locator('[aria-labelledby="knowledge-decisions-title"] .knowledge-row-main');
    await decisions.first().waitFor();
    expect(await decisions.first().isDisabled()).toBe(true);
    expect(await page.locator(".boundary-error").count()).toBe(0);
    expect(pageErrors).toEqual([]);
    page.off("pageerror", onPageError);
    await page.unroute("**/api/p/raceway/knowledge/activity");
  });

  it("shares URL-filtered rows across desktop/mobile and keeps truthful operational labels", async () => {
    if (process.env.DASHBOARD_SCREENSHOTS) {
      await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&sort=priority&direction=asc`);
      await page.locator("#raceway-title").waitFor();
      await page.screenshot({ path: "/tmp/memracer-task-143-cutover-desktop.png", fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: "/tmp/memracer-task-143-cutover-mobile.png", fullPage: true });
      await page.screenshot({ path: "/tmp/memracer-task-167-after-mobile-activity.png", fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: "/tmp/memracer-task-163-overview.png", fullPage: true });
      await page.screenshot({ path: "/tmp/memracer-task-164-information-architecture.png", fullPage: true });
    }
    // This direct fixture update emits no queue changed event. The React clock
    // must remove the lease at the deadline from the already-fetched DTO.
    await dbRef.prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?").run(Date.now() + 5_000, activeTaskId);
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&sort=priority&direction=asc`);
    await page.locator("#raceway-title").waitFor();
    await expect.poll(() => page.locator(".live-heartbeat").textContent()).toContain("Connected");
    const statusText = await page.locator(".status-band").textContent();
    expect(statusText).toContain("last 7 days");
    expect(statusText).toContain("no change");
    expect(statusText).not.toContain("+0");
    const statusBand = page.locator(".status-band");
    expect(await statusBand.locator(".status-label").allTextContents()).toEqual([
      "Open work", "Active coders", "Ready to claim", "Done in window",
    ]);
    expect(await statusBand.locator("select").count()).toBe(0);
    expect(await statusBand.locator("pre, code").count()).toBe(0);
    expect(await statusBand.locator("[data-identity-key]").count()).toBe(0);
    expect(await statusBand.textContent()).not.toMatch(/[{}]|queue_generation|isPending|endpoint|undefined|null/);
    expect(await statusBand.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await statusBand.locator(".status-value, .snapshot-trend").evaluateAll((nodes) =>
      nodes.every((node) => /JetBrains Mono/.test(getComputedStyle(node).fontFamily)),
    )).toBe(true);
    expect(await statusBand.locator(".status-label").evaluateAll((nodes) =>
      nodes.every((node) => /Space Grotesk/.test(getComputedStyle(node).fontFamily)),
    )).toBe(true);
    await statusBand.getByRole("button", { name: "About Ready to claim" }).focus();
    expect(await page.getByRole("tooltip").textContent()).toContain("available for a coder to claim");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await statusBand.locator(".status-cell").filter({ hasText: "Ready to claim" }).locator(".snapshot-trend").textContent()).toMatch(/\d+ fewer|no change|\d+ more/);
    const needsYou = page.locator(".operations-surfaces > .needs-you-panel");
    const attentionText = await needsYou.textContent();
    expect(attentionText).toContain("Lease expires soon.");
    expect(attentionText).toContain("BLOCKED");
    expect(attentionText).not.toContain("state =");
    expect(attentionText).toContain("Should this retry wait for the failing check?");
    expect(attentionText).not.toContain("Which retry path?");
    expect(attentionText).not.toContain("Resolved:");
    expect(attentionText).not.toContain("Deliberately parked rollout");
    expect(await needsYou.locator('.attention-row[data-kind="held"]').count()).toBe(0);
    expect(await needsYou.locator(".attention-row").count()).toBe(2);
    expect(await needsYou.locator('.attention-row[data-kind="blocked"] .state-chip').textContent()).toBe("BLOCKED");
    expect(await needsYou.locator('.attention-row[data-kind="lease"] .state-chip').textContent()).toBe("LEASE");
    expect(await needsYou.locator(".attention-context").allTextContents()).toEqual([`#${blockedTaskId}—blocked`, `#${activeTaskId}—lease`]);
    expect(await needsYou.locator(".attention-row-copy > b").evaluateAll((reasons) => reasons.every((reason) => getComputedStyle(reason).webkitLineClamp === "2"))).toBe(true);
    expect(await needsYou.locator(".attention-actor [data-actor-role]").count()).toBe(2);
    expect(await needsYou.locator(".attention-list").evaluate((list) => getComputedStyle(list).maxHeight)).toBe("384px");
    await needsYou.locator(".attention-actor").first().hover();
    expect(await page.getByRole("tooltip").textContent()).toMatch(/attention source/);
    await page.mouse.move(0, 0);
    await needsYou.locator('.attention-row[data-kind="blocked"] .attention-row-copy > b').hover();
    // Tooltip carries reason + recovery when both exist.
    expect(await page.getByRole("tooltip").textContent()).toContain("Should this retry wait for the failing check?");
    expect(await page.getByRole("tooltip").textContent()).toMatch(/Answer question|human_answer|retry/i);
    await page.mouse.move(0, 0);
    if (process.env.DASHBOARD_SCREENSHOTS) {
      await needsYou.screenshot({ path: "/tmp/memracer-task-225-needs-you-clean.png" });
      await page.screenshot({ path: "/tmp/memracer-task-233-after-1440.png", fullPage: true });
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      await page.screenshot({ path: "/tmp/memracer-task-302-after-light-1440.png", fullPage: true });
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await page.screenshot({ path: "/tmp/memracer-task-302-after-dark-1440.png", fullPage: true });
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      await page.screenshot({ path: "/tmp/memracer-task-235-after-1440.png", fullPage: true });
    }
    const attentionTrigger = needsYou.locator(`button.attention-task-trigger[data-task-trigger="${blockedTaskId}"]`);
    await attentionTrigger.focus();
    await page.keyboard.press("Enter");
    await page.locator(".task-sheet").waitFor();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".task-sheet").count()).toBe(0);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.taskTrigger)).toBe(String(blockedTaskId));
    expect(await page.locator(".operations-surfaces .panel-heading .section-kicker").count()).toBe(0);
    expect(await page.locator(".status-reading").count()).toBe(4);
    expect(await page.locator(".status-reading").evaluateAll((readings) => readings.every((reading) =>
      reading.querySelector(":scope > .status-value") !== null && reading.querySelector(":scope > .snapshot-trend") !== null
    ))).toBe(true);
    expect(await page.locator(".status-reading").evaluateAll((readings) => readings.every((reading) => {
      const value = reading.querySelector<HTMLElement>(":scope > .status-value")!.getBoundingClientRect();
      const trend = reading.querySelector<HTMLElement>(":scope > .snapshot-trend")!.getBoundingClientRect();
      const gap = trend.left - value.right;
      return gap >= 0 && gap <= 8;
    }))).toBe(true);
    expect(await page.locator('.status-cell[data-metric="active"] .status-value').evaluate((node) => {
      const style = getComputedStyle(node);
      return { color: style.color, fontVariantNumeric: style.fontVariantNumeric, letterSpacing: style.letterSpacing };
    })).toEqual({ color: "rgb(0, 100, 199)", fontVariantNumeric: "tabular-nums", letterSpacing: "normal" });
    expect(await page.locator(".panel-heading h2").first().evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(/system-ui|sans-serif/i);
    // Mature fixture has a connected coder seat → Get started stays hidden.
    expect(await page.locator(".operations-surfaces").evaluate((node) => [...node.children].map((child) => child.classList[0]))).toEqual([
      "needs-you-panel", "status-band", "queue-panel", "on-hold-panel", "roster", "live-work-grid", "raceway",
    ]);
    expect(await page.locator(".get-started-panel").count()).toBe(0);
    const onHold = page.locator(".operations-surfaces > .on-hold-panel");
    expect(await onHold.locator(".panel-note").textContent()).toMatch(/2 parked/);
    expect(await onHold.textContent()).toContain("Deliberately parked rollout");
    expect(await onHold.textContent()).toContain("Warming consent gate");
    expect(await onHold.textContent()).toContain("Held by operator");
    expect(await onHold.locator('.on-hold-row[data-state="HELD"] .state-chip').getAttribute("data-tone")).toBe("held");
    expect(await onHold.locator('.on-hold-row[data-state="INCUBATING"] .state-chip').getAttribute("data-tone")).toBe("incubating");
    const heldOpen = onHold.locator('button.on-hold-task-trigger[data-task-trigger][aria-haspopup="dialog"]').filter({ hasText: "Open" }).first();
    await heldOpen.click();
    await page.locator(".task-sheet").waitFor();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".task-sheet").count()).toBe(0);
    expect((await page.locator(".queue-panel").boundingBox())!.y).toBeLessThan(760);
    expect(await page.locator(".operations-surfaces").textContent()).not.toMatch(/Signal raceway|Lifecycle motion|Work signals|Live roster|Active leases/);
    expect(await page.locator(".raceway-lane").count()).toBe(2);
    expect(await page.locator(".raceway").textContent()).toContain("QUEUED→CLAIMED");
    expect(await page.locator(".raceway").textContent()).toContain("QUEUED→BLOCKED");
    expect(await page.locator(".raceway").textContent()).not.toContain("no transition observed");
    expect(await page.locator(".queue-table-wrap tbody tr").count()).toBe(3);
    expect(await page.locator(".queue-cards .queue-card").count()).toBe(3);
    expect(await page.locator(".queue-table-wrap tbody tr:not([role])").count()).toBe(3);
    expect(await page.locator(".queue-cards article.queue-card:not([role])").count()).toBe(3);
    expect(await page.locator('.queue-table-wrap tbody tr button.queue-task-trigger[data-task-trigger][aria-haspopup="dialog"]').count()).toBe(3);
    expect(await page.locator('.queue-cards article.queue-card button.queue-task-trigger[data-task-trigger][aria-haspopup="dialog"]').count()).toBe(3);
    expect(await page.locator('.queue-table-wrap tbody tr, .queue-cards article.queue-card').evaluateAll((containers) => containers.every((container) =>
      container.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])').length === 1,
    ))).toBe(true);
    expect(await page.getByText("Archive completed rollout", { exact: true }).count()).toBe(0);
    expect(await page.locator("#queue-state-filter").count()).toBe(0);
    expect(await page.locator("#queue-agent-filter").count()).toBe(0);
    expect(await page.locator(".queue-panel .filter-rail").count()).toBe(0);
    expect(await page.locator(".queue-heading #queue-sort").count()).toBe(1);
    expect(await page.locator('.queue-panel [data-identity-key^="task:"]').count()).toBe(0);
    expect(await page.locator(".queue-table-wrap .queue-task-summary").count()).toBe(3);
    expect(await page.locator(".queue-table-wrap .state-chip").count()).toBe(3);
    expect(await page.locator(".queue-table-wrap .queue-priority").evaluateAll((priorities) => priorities.every((priority) => /^P[0-3]$/.test(priority.textContent ?? "")))).toBe(true);
    expect(await page.locator(".queue-table-wrap .queue-timing").count()).toBe(3);
    const roster = page.locator(".operations-surfaces > .roster.active-coders-strip");
    const rosterToggle = roster.locator(".active-coders-toggle");
    expect(await rosterToggle.getAttribute("aria-expanded")).toBe("false");
    expect(await rosterToggle.textContent()).toMatch(/Active Coders:\s*1/);
    expect(await roster.locator(".roster-row").count()).toBe(0);
    await rosterToggle.click();
    expect(await rosterToggle.getAttribute("aria-expanded")).toBe("true");
    expect(await roster.locator(".roster-row").count()).toBe(1);
    // Activity is full-width below the strip (not a side column next to roster).
    expect(await page.locator(".live-work-grid > .roster").count()).toBe(0);
    expect(await page.locator(".live-work-grid > .feed-surface").count()).toBe(1);
    const rosterGeometry = await page.locator(".operations-surfaces > .roster .roster-row").evaluate((row) => {
      const actor = row.querySelector<HTMLElement>(".ui-actor-label")!;
      const title = row.querySelector<HTMLElement>("strong")!;
      const lease = row.querySelector<HTMLElement>(".roster-lease time")!;
      const style = getComputedStyle(title);
      return {
        actorWidth: actor.getBoundingClientRect().width,
        fontFamily: style.fontFamily,
        titleWidth: title.getBoundingClientRect().width,
        leaseWidth: lease.getBoundingClientRect().width,
        rowHeight: row.getBoundingClientRect().height,
      };
    });
    expect(rosterGeometry.actorWidth).toBeLessThanOrEqual(190);
    expect(rosterGeometry.titleWidth).toBeGreaterThan(60);
    expect(rosterGeometry.leaseWidth).toBeGreaterThan(28);
    expect(rosterGeometry.rowHeight).toBeLessThanOrEqual(82);
    expect(rosterGeometry.fontFamily).toMatch(/system-ui|sans-serif/i);
    expect(await roster.locator("select").count()).toBe(0);
    expect(await roster.locator("pre").count()).toBe(0);
    expect(await roster.locator('[data-identity-key^="task:"]').count()).toBe(0);
    expect(await roster.textContent()).not.toMatch(/\/agents|payload|endpoint|\{.*\}/i);
    expect(await roster.locator(".state-chip").count()).toBe(1);
    expect(await roster.locator(".state-chip").getAttribute("data-state")).toBe(await roster.locator(".roster-row").getAttribute("data-state"));
    await roster.locator('.ui-actor-label[data-actor-role="coder"]').hover();
    expect(await page.getByRole("tooltip").textContent()).toBe("coder");
    await page.mouse.move(0, 0);
    const rosterCountdownWidth = await roster.locator(".roster-lease time").evaluate((node) => node.getBoundingClientRect().width);
    await page.waitForTimeout(1_050);
    expect(await roster.locator(".roster-lease time").evaluate((node) => node.getBoundingClientRect().width)).toBe(rosterCountdownWidth);
    const readableReview = page.locator(`[data-thread-id="${timelineChildThreadId}"]`);
    expect(await readableReview.textContent()).toContain(`Approved · #${activeTaskId} · Unwedge merge queue`);
    expect(await readableReview.locator(".feed-row-head").textContent()).toContain(`#${activeTaskId} — Unwedge merge queue`);
    expect(await page.locator('.feed-surface nav').textContent()).not.toContain('{"verdict"');
    expect(await page.locator('.feed-surface nav').textContent()).not.toMatch(/thread \d+/i);
    // Activity rows with a task expose the same open-task control as Queue/Needs-You/Roster.
    const feedOpen = page.locator(`.feed-surface button.feed-task-trigger[data-task-trigger="${activeTaskId}"][aria-haspopup="dialog"]`);
    expect(await feedOpen.count()).toBeGreaterThan(0);
    expect(await feedOpen.first().getAttribute("aria-label")).toContain(`Open task ${activeTaskId}:`);
    // Selecting the thread keeps the timeline inline and does not open the task sheet.
    await readableReview.locator("button.feed-row-select").click();
    expect(await page.locator(".task-sheet").count()).toBe(0);
    expect(await new URL(page.url()).searchParams.get("task")).toBe(null);
    await feedOpen.first().click();
    await page.locator(".task-sheet").waitFor();
    await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(String(activeTaskId));
    // FeedSurface unmounts while a task sheet is open; close restores the feed and clears the task param.
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".task-sheet").count()).toBe(0);
    await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(null);
    await page.locator(".feed-surface").waitFor();
    expect(await page.locator(`.feed-surface button.feed-task-trigger[data-task-trigger="${activeTaskId}"][aria-haspopup="dialog"]`).count()).toBeGreaterThan(0);
    // Open controls always carry a task id; no bare feed-task-trigger without data-task-trigger.
    expect(await page.locator(".feed-surface button.feed-task-trigger:not([data-task-trigger])").count()).toBe(0);
    expect(await page.locator(".queue-heading .panel-note").textContent()).toBe("3 actionable");
    const queueVisibility = page.locator(".queue-visibility");
    expect(await queueVisibility.textContent()).toContain("View all 5");
    await queueVisibility.click();
    expect(await page.locator(".queue-heading .panel-note").textContent()).toBe("5 shown");
    expect(await page.locator(".queue-table-wrap tbody tr").count()).toBe(5);
    await queueVisibility.click();
    expect(await page.locator(".queue-table-wrap tbody tr").count()).toBe(3);
    const completedTrigger = page.getByRole("button", { name: "Completed", exact: true });
    await completedTrigger.click();
    const completedDialog = page.getByRole("dialog", { name: "Completed tasks" });
    await completedDialog.waitFor();
    expect(await page.getByRole("dialog").count()).toBe(1);
    await completedDialog.locator(".completed-table").getByText("Archive completed rollout", { exact: true }).waitFor();
    expect(await completedDialog.locator(".completed-table").getByText("Archive completed rollout", { exact: true }).count()).toBe(1);
    expect(await completedDialog.locator(".completed-table").isVisible()).toBe(true);
    expect(await completedDialog.locator(".completed-cards").isVisible()).toBe(false);
    await completedDialog.locator(`.completed-table .completed-row:has-text("Archive completed rollout")`).click();
    await page.locator(".task-sheet").waitFor();
    expect(await page.getByRole("dialog").count()).toBe(1);
    expect(await completedDialog.count()).toBe(0);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Completed");
    await completedTrigger.click();
    await completedDialog.getByRole("searchbox", { name: "Search completed tasks" }).fill("missing archive");
    await completedDialog.getByText("No completed tasks match this search.", { exact: true }).waitFor();
    await completedDialog.getByRole("button", { name: "Close completed tasks" }).click();
    await completedTrigger.click();
    expect(await completedDialog.getByRole("searchbox", { name: "Search completed tasks" }).inputValue()).toBe("missing archive");
    await completedDialog.getByRole("button", { name: "Close completed tasks" }).click();
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-195-after-desktop.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-166-after-legibility.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-167-after-queue-roster.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-211-queue-desktop.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-231-after-1440.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-237-after-1440.png", fullPage: true });
    expect(await page.locator('.queue-table-wrap tbody tr [data-actor-role]').count()).toBe(3);
    await page.locator(".queue-table-wrap .queue-owner").first().hover();
    expect(await page.getByRole("tooltip").textContent()).toMatch(/lease owner|submitter/);
    const desktopRosterStrip = page.locator(".operations-surfaces > .roster.active-coders-strip");
    // May already be expanded from earlier assertions in this test.
    if ((await desktopRosterStrip.locator(".active-coders-toggle").getAttribute("aria-expanded")) !== "true") {
      await desktopRosterStrip.locator(".active-coders-toggle").click();
    }
    expect(await page.locator('.operations-surfaces > .roster .roster-row [data-actor-role="coder"]').count()).toBe(1);
    expect(await page.locator('.feed-surface nav [data-actor-role]').count()).toBeGreaterThan(1);
    await page.locator('.visual-key > summary').click();
    expect(await page.locator('.visual-key-popover [data-actor-role]').count()).toBe(3);
    expect(await page.locator('.visual-key-popover [data-actor-role="mediator"] .actor-role').textContent()).toBe("Frigg");
    expect(await page.locator('.visual-key-popover').textContent()).not.toContain("mediator");
    expect(await page.locator('.visual-key-popover .state-chip').count()).toBe(5);
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-167-after-legend.png", fullPage: true });
    await page.locator('.visual-key > summary').click();

    const rosterTrigger = page.locator(`.operations-surfaces > .roster button[data-task-trigger="${activeTaskId}"]`);
    await rosterTrigger.focus();
    await page.keyboard.press("Enter");
    await page.locator(".task-sheet").waitFor();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".task-sheet").count()).toBe(0);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.classList.contains("roster-task-trigger"))).toBe(true);

    const row = page.locator(`.queue-table-wrap tbody tr:has(button[data-task-trigger="${activeTaskId}"])`);
    const rowTrigger = row.locator("button.queue-task-trigger");
    expect(await row.getAttribute("role")).toBe(null);
    expect(await rowTrigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(await row.evaluate((node) => getComputedStyle(node).cursor)).toBe("auto");
    expect((await rowTrigger.textContent())?.trim()).toBe("Open");
    await row.scrollIntoViewIfNeeded();
    await rowTrigger.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(String(activeTaskId));
    await page.locator(".task-sheet").waitFor();
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-165-queue-interaction.png", fullPage: true });
    await page.goBack();
    await expect.poll(() => page.locator(".task-sheet").count()).toBe(0);
    await rowTrigger.focus();
    const focusedTrigger = await rowTrigger.elementHandle();
    expect(focusedTrigger).not.toBeNull();
    // Cross more than one QueueSurface clock tick. The live timing cells must
    // rerender without replacing the focused Open button.
    await page.waitForTimeout(2_100);
    expect(await focusedTrigger!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await rowTrigger.evaluate((node, original) => node === original, focusedTrigger)).toBe(true);
    expect(await focusedTrigger!.evaluate((node) => document.activeElement === node)).toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(String(activeTaskId));
    await page.keyboard.press("Escape");
    await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(null);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toContain(`Open task ${activeTaskId}:`);

    await expect.poll(() => page.locator(".status-cell").filter({ hasText: "active" }).locator(".status-value").textContent(), { timeout: 8_000 }).toBe("0");
    // Expanded strip shows empty state (no live leases) rather than rows.
    if ((await desktopRosterStrip.locator(".active-coders-toggle").getAttribute("aria-expanded")) !== "true") {
      await desktopRosterStrip.locator(".active-coders-toggle").click();
    }
    await expect.poll(() => page.locator(".operations-surfaces > .roster .roster-row").count()).toBe(0);

    await page.locator("#queue-sort").focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.classList.contains("direction-button"))).toBe(true);

    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&state=BLOCKED&sort=priority&direction=asc`);
    await page.locator("#queue-sort").waitFor();
    expect(await page.locator(".queue-table-wrap tbody tr").count()).toBe(1);
    expect(await page.locator(".queue-cards .queue-card").count()).toBe(1);

    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&state=DONE`);
    await page.locator("#queue-sort").waitFor();
    expect(await page.locator(".queue-table-wrap tbody tr").count()).toBe(0);
    expect(await page.getByText("Archive completed rollout", { exact: true }).count()).toBe(0);
    expect(await page.locator(`.queue-table-wrap tbody tr:has(button[data-task-trigger="${doneTaskId}"])`).count()).toBe(0);
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&state=BLOCKED`);
    await page.locator("#queue-sort").waitFor();

    await dbRef.prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?").run(Date.now() + 120_000, activeTaskId);
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&sort=priority&direction=asc`);
    await page.locator("#queue-sort").waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileTabs = page.getByRole("navigation", { name: "Mobile views" });
    for (const [tab, selector] of [["You", ".you-surface"], ["Activity", ".feed-surface"], ["Queue", ".queue-panel"]] as const) {
      await mobileTabs.getByRole("button", { name: tab }).click();
      await page.locator(selector).waitFor({ state: "visible" });
      expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= window.innerWidth)).toBe(true);
      if (tab === "You") {
        expect(await page.locator(".you-surface .attention-list").evaluate((list) => Number.parseFloat(getComputedStyle(list).maxHeight))).toBeLessThanOrEqual(338);
        expect(await page.locator(".status-band").isVisible()).toBe(true);
        expect(await page.locator(".status-grid").evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length)).toBe(2);
        expect(await page.locator(".status-band").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        const mobileRoster = page.locator(".you-surface .roster");
        expect(await mobileRoster.locator(".roster-row").count()).toBe(1);
        expect(await page.locator(".operations-surfaces > .roster.active-coders-strip").isVisible()).toBe(false);
        expect(await mobileRoster.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-233-after-390.png", fullPage: true });
        if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-235-after-390.png", fullPage: true });
        if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-237-after-390.png", fullPage: true });
      }
      if (process.env.DASHBOARD_SCREENSHOTS) {
        await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
        await page.screenshot({ path: `/tmp/memracer-task-302-${tab}-light-390.png`, fullPage: true });
        await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
        await page.screenshot({ path: `/tmp/memracer-task-302-${tab}-dark-390.png`, fullPage: true });
        await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      }
    }
    expect(await page.locator(".queue-card").first().isVisible()).toBe(true);
    expect(await page.locator(".queue-table-wrap").isVisible()).toBe(false);
    expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
    const mobileCompletedTrigger = page.getByRole("button", { name: "Completed", exact: true });
    await mobileCompletedTrigger.click();
    const mobileCompletedDialog = page.getByRole("dialog", { name: "Completed tasks" });
    await mobileCompletedDialog.waitFor();
    await mobileCompletedDialog.getByRole("searchbox", { name: "Search completed tasks" }).fill("");
    await mobileCompletedDialog.locator(".completed-cards .completed-row").first().waitFor();
    expect(await mobileCompletedDialog.locator(".completed-table").isVisible()).toBe(false);
    expect(await mobileCompletedDialog.locator(".completed-cards").isVisible()).toBe(true);
    expect(await mobileCompletedDialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await mobileCompletedDialog.getByRole("button", { name: "Close completed tasks" }).click();
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-195-after-375.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-211-queue-mobile.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-231-after-390.png", fullPage: true });
    const mobileTrigger = page.locator(".queue-card button.queue-task-trigger").first();
    await mobileTrigger.focus();
    const mobileTriggerId = await mobileTrigger.getAttribute("data-task-trigger");
    await mobileTrigger.press("Space");
    await page.locator(".task-sheet").waitFor();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".task-sheet").count()).toBe(0);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.taskTrigger)).toBe(mobileTriggerId);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&agent=departed-agent`);
    await page.locator("#queue-sort").waitFor();
    expect(await page.locator("#queue-state-filter").count()).toBe(0);
    expect(await page.locator("#queue-agent-filter").count()).toBe(0);
    expect(await page.locator(".queue-panel .empty-copy").textContent()).toContain("No tasks match");

    await chooseSelect("Project", "Empty Project");
    await expect.poll(() => new URL(page.url()).searchParams.get("project")).toBe("empty");
    await expect.poll(() => page.locator(".raceway .empty-copy").textContent()).toContain("No task movement in the last 7 days");
    await expect.poll(() => page.locator(".queue-panel .empty-copy").textContent()).toContain("No tasks match");

    await page.goto(`${baseUrl}/dashboard/?project=not-a-membership&view=dashboard`);
    await expect.poll(() => page.locator(".live-heartbeat").getAttribute("data-status")).toBe("unavailable");
    expect(await page.locator(".error-panel").textContent()).toContain("Project unavailable");
  }, 60_000);

  it("keeps the exact task trigger stable and restores it after an SSE reorder", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dbRef.prepare("UPDATE tasks SET priority = 0 WHERE id = ?").run(activeTaskId);
    queueRef.notifyChanged("raceway");
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&sort=priority&direction=asc`);
    const trigger = page.locator(`.queue-table-wrap button[data-task-trigger="${activeTaskId}"]`);
    await trigger.waitFor();
    await trigger.focus();
    const originalNode = await trigger.elementHandle();
    const timing = page.locator(`.queue-table-wrap tbody tr:has(button[data-task-trigger="${activeTaskId}"]) .queue-timing`);
    const timingBefore = await timing.textContent();
    await page.waitForTimeout(2_100);
    expect(await timing.textContent()).not.toBe(timingBefore);
    expect(await originalNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await trigger.evaluate((node, original) => node === original, originalNode)).toBe(true);
    expect(await originalNode!.evaluate((node) => document.activeElement === node)).toBe(true);
    await trigger.click();
    await page.locator(".task-sheet").waitFor();

    await dbRef.prepare("UPDATE tasks SET priority = 4, updated_at = ? WHERE id = ?").run(Date.now(), activeTaskId);
    queueRef.notifyChanged("raceway");
    await expect.poll(() => page.locator(".queue-table-wrap tbody tr button[data-task-trigger]").evaluateAll((buttons, taskId) =>
      buttons.findIndex((button) => button.getAttribute("data-task-trigger") === taskId), String(activeTaskId),
    )).toBe(2);
    expect(await originalNode!.evaluate((node) => (node as HTMLElement).dataset.taskTrigger)).toBe(String(activeTaskId));
    expect(await originalNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await trigger.evaluate((node, original) => node === original, originalNode)).toBe(true);

    await page.keyboard.press("Escape");
    await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(null);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.taskTrigger)).toBe(String(activeTaskId));
    expect(await originalNode!.evaluate((node) => document.activeElement === node)).toBe(true);

    await dbRef.prepare("UPDATE tasks SET priority = 2, updated_at = ? WHERE id = ?").run(Date.now(), activeTaskId);
    queueRef.notifyChanged("raceway");
  }, 20_000);

  it("keeps task detail URL, focus, history, mobile sheet, and attribution contracts", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard`);
    const trigger = page.locator(`.queue-table-wrap button[data-task-trigger="${activeTaskId}"]`);
    await trigger.waitFor();
    expect(await page.locator('.queue-panel [data-identity-key^="task:"]').count()).toBe(0);
    await trigger.click();
    await page.locator(".task-sheet").waitFor();
    await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(String(activeTaskId));
    expect(await page.locator(".detail-identity").textContent()).toBe(`Task #${activeTaskId}`);
    expect(await page.locator('.task-sheet [data-identity-key^="task:"]').count()).toBe(0);
    expect(await page.locator(".task-sheet").textContent()).toContain("Unwedge merge queue");
    expect(await page.locator(".task-human-summary > p").textContent()).toBe("Restore merge dispatch after stale checks block active work.");
    const longTitle = "Bound this deliberately long task detail title across every narrow and desktop dashboard viewport without allowing the heading to consume the operational record";
    await dbRef.prepare("UPDATE tasks SET title=?, updated_at=? WHERE id=?").run(longTitle, Date.now(), activeTaskId);
    await page.reload();
    await page.locator(".task-sheet").waitFor();
    const sheetTitle = page.locator(".task-human-summary > h2");
    expect(await sheetTitle.textContent()).toBe(longTitle);
    expect(await sheetTitle.evaluate((title) => {
      const style = getComputedStyle(title);
      return { clamp: style.webkitLineClamp, bounded: title.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) * 2 + 1 };
    })).toEqual({ clamp: "2", bounded: true });
    await sheetTitle.hover();
    expect(await page.getByRole("tooltip").textContent()).toBe(longTitle);
    if (process.env.DASHBOARD_SCREENSHOTS) await page.locator(".task-sheet").screenshot({ path: "/tmp/memracer-task-302-long-title-1440.png" });
    await dbRef.prepare("UPDATE tasks SET title='Unwedge merge queue', updated_at=? WHERE id=?").run(Date.now(), activeTaskId);
    await page.reload();
    await page.locator(".task-sheet").waitFor();
    expect(await page.locator(".task-summary-status").textContent()).toContain("CLAIMED");
    expect(await page.locator(".task-summary-status").textContent()).toContain("codex-home");
    await page.getByRole("tab", { name: /^Evidence/ }).click();
    const attachedImage = page.locator('.task-images img[alt="Merge queue failure reference"]');
    await attachedImage.waitFor();
    await expect.poll(() => attachedImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await page.locator(".task-image-card figcaption").textContent()).toContain("Merge queue failure reference");
    expect(await page.locator(".task-content-card pre, .evidence-row pre, #plan pre").count()).toBe(0);
    expect(await page.locator(".task-sheet select").count()).toBe(0);
    if (process.env.DASHBOARD_SCREENSHOTS) {
      await page.screenshot({ path: "/tmp/memracer-task-166-after-task-summary.png", fullPage: true });
      await page.screenshot({ path: "/tmp/memracer-task-167-after-detail.png", fullPage: true });
      await page.screenshot({ path: "/tmp/memracer-task-219-after-task-sheet.png", fullPage: true });
      await page.locator(".task-sheet").screenshot({ path: "/tmp/memracer-task-221-after-task-sheet-desktop.png" });
      await page.locator(".task-sheet").screenshot({ path: "/tmp/memracer-task-172-image-gallery-desktop.png" });
    }
    expect(await page.locator('.task-summary-status [data-actor-role="coder"]').textContent()).toContain("codex-home");
    expect(await page.locator('.task-sheet-sidebar [data-actor-role="human"]').textContent()).toContain("Operator");
    await page.getByRole("tab", { name: /^Specification/ }).click();
    expect(await page.locator(".task-body-copy").textContent()).toContain("Evidence: raw queue diagnostics");
    expect(await page.locator("#plan code").textContent()).toContain("Preserve queue ordering");
    await page.getByRole("tab", { name: /^Conversation/ }).click();
    await page.locator('.aui-msg[data-event-id]').first().waitFor();
    expect(await page.locator('.aui-msg[data-event-id]').count()).toBe(6);
    expect(await page.getByRole("region", { name: "Session replay controls" }).count()).toBe(0);
    await page.getByRole("tab", { name: /^Decisions/ }).click();
    const decisionActors = await page.locator('.decision-row [data-actor-role="mediator"] b').allTextContents();
    expect(decisionActors.length).toBeGreaterThan(0);
    expect(decisionActors.every((label) => label === "Frigg")).toBe(true);
    await page.locator('.decision-row [data-actor-role="mediator"]').first().hover();
    await page.getByRole("tooltip", { name: "Frigg" }).waitFor();
    await page.getByRole("tab", { name: /^Conversation/ }).click();

    await page.keyboard.press("Escape");
    await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(null);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.taskTrigger)).toBe(String(activeTaskId));
    await page.goBack();
    await page.locator(".task-sheet").waitFor();
    expect(new URL(page.url()).searchParams.get("task")).toBe(String(activeTaskId));
    await page.goForward();
    await expect.poll(() => page.locator(".task-sheet").count()).toBe(0);

    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&task=${activeTaskId}#plan`);
    await page.locator(".task-sheet").waitFor();
    expect(await page.getByRole("tab", { name: /^Specification/ }).getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#plan").textContent()).toContain("Preserve queue ordering");

    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&task=999999`);
    await expect.poll(() => page.locator(".sheet-state").textContent()).toContain("Task not found");
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&task=${activeTaskId}`);
    await page.locator(".task-sheet").waitFor();
    await page.getByRole("tab", { name: /^Evidence/ }).click();
    await page.locator(".task-images img").waitFor();
    const width = await page.locator(".task-sheet").evaluate((node) => Math.round(node.getBoundingClientRect().width));
    expect(width).toBe(390);
    expect(await page.locator(".task-sheet-main").evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(390);
    expect(await page.locator(".task-sheet-sidebar").evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(390);
    expect(await page.locator(".task-images").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    if (process.env.DASHBOARD_SCREENSHOTS) {
      await page.locator(".task-sheet").screenshot({ path: "/tmp/memracer-task-172-image-gallery-mobile.png" });
      await page.locator(".task-sheet").screenshot({ path: "/tmp/memracer-task-221-after-task-sheet-phone.png" });
    }
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 1000 });
  }, 60_000);

  it("restores Knowledge and Team analytics through URL, command, and mobile navigation", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=knowledge`);
    await expect.poll(() => page.locator(".knowledge-reader").textContent()).toContain("Knowledge activity");
    expect(await page.locator(".knowledge-list > header h2").textContent()).toBe("Explorer");
    const tree = page.getByRole("tree", { name: "Knowledge concepts" });
    await tree.waitFor();
    expect(await tree.getByRole("treeitem").count()).toBeGreaterThan(4);
    expect(await tree.locator(".knowledge-tree-row.is-concept > i").count()).toBe(0);
    const techFolder = tree.getByRole("treeitem", { name: /^tech$/ });
    expect(await techFolder.getAttribute("aria-expanded")).toBe("true");
    expect(await techFolder.getAttribute("aria-level")).toBe("1");
    const runtimeFolder = tree.getByRole("treeitem", { name: /^runtime$/ });
    expect(await runtimeFolder.getAttribute("aria-expanded")).toBe("false");
    await runtimeFolder.click();
    expect(await runtimeFolder.getAttribute("aria-expanded")).toBe("true");
    await page.keyboard.press("ArrowLeft");
    expect(await runtimeFolder.getAttribute("aria-expanded")).toBe("false");
    await page.keyboard.press("ArrowRight");
    expect(await runtimeFolder.getAttribute("aria-expanded")).toBe("true");
    const workerConcept = tree.getByRole("treeitem", { name: /Worker jobs/ });
    expect(await workerConcept.getAttribute("aria-level")).toBe("3");
    await techFolder.click();
    expect(await techFolder.getAttribute("aria-expanded")).toBe("false");
    await page.keyboard.press("ArrowRight");
    expect(await techFolder.getAttribute("aria-expanded")).toBe("true");
    await page.keyboard.press("ArrowLeft");
    expect(await techFolder.getAttribute("aria-expanded")).toBe("false");
    await page.keyboard.press("ArrowRight");
    expect(await techFolder.getAttribute("aria-expanded")).toBe("true");
    await page.keyboard.press("Home");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("treeitem");
    await page.keyboard.press("End");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("treeitem");
    const treeSearch = page.getByPlaceholder("Search knowledge");
    await page.keyboard.press("w");
    await expect.poll(() => treeSearch.inputValue()).toBe("w");
    await treeSearch.fill("architecture");
    expect(await tree.getByRole("treeitem", { name: /Worker jobs/ }).count()).toBe(1);
    await treeSearch.fill("worker");
    await expect.poll(() => treeSearch.inputValue()).toBe("worker");
    expect(await tree.getByRole("treeitem", { name: /Worker jobs/ }).count()).toBe(1);
    expect(await tree.getByRole("treeitem", { name: /Product framing/ }).count()).toBe(0);
    await page.getByRole("button", { name: "Clear knowledge search" }).click();
    await treeSearch.fill("product");
    expect(await tree.getByRole("treeitem", { name: /^decisions$/ }).count()).toBe(1);
    await tree.getByRole("treeitem", { name: /Product framing/ }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("concept")).toBe("decisions/product-framing.md");
    const knowledgeBodyText = await page.locator(".knowledge-body").textContent();
    expect(knowledgeBodyText).toContain("operational surface");
    expect(knowledgeBodyText).not.toContain("Leaked fixture metadata");
    expect(knowledgeBodyText).not.toContain("tags: [product]");
    expect(await page.locator(".knowledge-body h1").textContent()).toBe("Operating model");
    expect(await page.locator(".knowledge-body li").count()).toBe(3);
    expect(await page.locator(".knowledge-body table").textContent()).toContain("operator");
    expect(await page.locator(".knowledge-body pre code").textContent()).toBe("pnpm test\n");
    expect(await page.locator('.knowledge-body a[href="../operations/missing.md#recovery"]').count()).toBe(0);
    expect(await page.locator(".knowledge-body").getByRole("button", { name: "missing runbook" }).count()).toBe(0);
    const externalRelease = page.locator('.knowledge-body a[href="https://example.com/release"]');
    expect(await externalRelease.getAttribute("target")).toBe("_blank");
    expect(await externalRelease.getAttribute("rel")).toBe("noopener noreferrer");
    if (process.env.DASHBOARD_SCREENSHOTS) {
      await page.locator(".knowledge-reader").screenshot({ path: "/tmp/memracer-task-207-knowledge-desktop.png" });
      await page.screenshot({ path: "/tmp/memracer-task-219-after-knowledge.png", fullPage: true });
    }
    await page.locator(".knowledge-body").getByRole("button", { name: "merge recovery" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("concept")).toBe("operations/merge-queue.md");
    await expect.poll(() => treeSearch.inputValue()).toBe("");
    expect(await page.locator(".knowledge-body").textContent()).toContain("Reset a stale queue entry");
    await page.locator(".knowledge-back").click();
    await page.getByRole("heading", { name: "Knowledge activity" }).waitFor();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-knowledge-path"))).toBe("operations/merge-queue.md");
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-189-knowledge-tree-desktop.png", fullPage: true });
    const activity = page.locator(".knowledge-activity");
    expect(await activity.getByRole("heading", { name: "Recent updates" }).count()).toBe(1);
    expect(await activity.getByRole("heading", { name: "Conventions in force" }).count()).toBe(1);
    expect(await activity.getByRole("heading", { name: "Decisions" }).count()).toBe(1);
    expect(await activity.textContent()).toContain("Prove inactive work");
    expect(await activity.textContent()).toContain("Require proof before replacement");
    expect(await activity.textContent()).not.toContain("curated@");
    expect(await page.locator(".knowledge-activity-row").evaluateAll((rows) => rows.every((row) => row.scrollWidth <= row.clientWidth))).toBe(true);
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-170-active-knowledge-desktop.png", fullPage: true });

    await activity.locator(".knowledge-row-main").filter({ hasText: "Merge queue recovery" }).first().click();
    await expect.poll(() => new URL(page.url()).searchParams.get("concept")).toBe("operations/merge-queue.md");
    expect(await page.locator(".knowledge-body").textContent()).toContain("Reset a stale queue entry");
    expect(await page.locator(".knowledge-provenance").textContent()).toContain("Recovery plan approved");
    await page.locator(".knowledge-provenance").getByRole("button", { name: "Task · Unwedge merge queue" }).click();
    await page.locator(".task-sheet").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await page.getByRole("heading", { name: "Knowledge activity" }).waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.getByRole("heading", { name: "Recent updates" }).isVisible()).toBe(true);
    expect(await page.locator(".knowledge-view").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.getByRole("tree", { name: "Knowledge concepts" }).isVisible()).toBe(true);
    await tree.getByRole("treeitem", { name: /Product framing/ }).click();
    await page.locator(".knowledge-body h1").waitFor();
    expect(await page.locator(".knowledge-body").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    if (process.env.DASHBOARD_SCREENSHOTS) await page.locator(".knowledge-reader").screenshot({ path: "/tmp/memracer-task-207-knowledge-mobile.png" });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-189-knowledge-tree-mobile.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-170-active-knowledge-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.keyboard.press("ControlOrMeta+K");
    const commandDialog = page.getByRole("dialog", { name: "Go to" });
    await commandDialog.waitFor();
    expect(await commandDialog.textContent()).toContain(`Approved · #${activeTaskId} · Unwedge merge queue`);
    expect(await commandDialog.textContent()).not.toContain('{"verdict"');
    await commandDialog.getByRole("button", { name: "Team analytics", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("team");
    await page.locator(".team-analytics-view").waitFor();
    await page.locator(".analytics-metric-rail").waitFor();
    expect(await page.getByRole("heading", { name: "Team analytics", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "View analytics", exact: true }).count()).toBe(0);
    expect(await page.locator(".analytics-metric").count()).toBe(5);
    expect(await page.locator(".analytics-contributor-bar").count()).toBeGreaterThan(0);
    expect(await page.locator('[aria-label="Model legend"]').textContent()).toContain("gemini");
    expect(await page.locator('[aria-label="Model legend"]').textContent()).toContain("glm");
    expect(await page.locator('[aria-label="Model legend"]').textContent()).toContain("other");
    expect(await page.locator('[aria-label="Model legend"]').textContent()).toContain("unattributed");
    expect(await page.locator(".analytics-view-toolbar").textContent()).toContain("7 days");
    expect(await page.locator(".team-analytics-view").textContent()).toContain("Contributor leaderboard");
    expect(await page.locator(".team-analytics-view").textContent()).toContain("Frigg model routing");
    expect(await page.locator(".analytics-contributors").textContent()).toContain("Operator");
    expect(await page.locator(".analytics-contributors").textContent()).toContain("Complete");
    // Stacked scorecard: distinct other vs unattributed colors + stable family order across bars.
    await page.locator(".analytics-scorecard-segment").first().waitFor();
    expect(await page.locator(".analytics-scorecard-segment").count()).toBeGreaterThanOrEqual(2);
    expect(await page.locator(".analytics-scorecard-segment.analytics-model-glm").count()).toBeGreaterThan(0);
    expect(await page.locator(".analytics-scorecard-segment.analytics-model-gemini").count()).toBeGreaterThan(0);
    expect(await page.locator(".analytics-scorecard-segment.analytics-model-other").count()).toBeGreaterThan(0);
    expect(await page.locator(".analytics-scorecard-segment.analytics-model-unknown").count()).toBeGreaterThan(0);
    const otherBg = await page.locator(".analytics-model-other").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const unknownBg = await page.locator(".analytics-model-unknown").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(otherBg).not.toBe(unknownBg);
    const familyOrder = ["gemini", "glm", "other", "unknown"] as const;
    const scorecardRows = page.locator(".analytics-scorecard-row");
    const rowCount = await scorecardRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < rowCount; i += 1) {
      const classes = await scorecardRows.nth(i).locator(".analytics-scorecard-segment").evaluateAll((nodes) =>
        nodes.map((node) => {
          const match = /analytics-model-(gemini|glm|other|unknown)/.exec(node.className);
          return match?.[1] ?? "missing";
        }),
      );
      const ranks = classes.map((slot) => familyOrder.indexOf(slot as typeof familyOrder[number]));
      expect(ranks.every((rank) => rank >= 0)).toBe(true);
      for (let j = 1; j < ranks.length; j += 1) {
        expect(ranks[j]).toBeGreaterThanOrEqual(ranks[j - 1]);
      }
    }
    const routingText = await page.locator(".analytics-routing").textContent();
    expect(routingText).toContain("glm-5.2");
    expect(routingText).toContain("gemini-3.1-flash-lite");
    expect(routingText).toContain("claude-sonnet-4");
    expect(routingText).toMatch(/\$6\.43/);
    // Nonzero sub-dollar flash-lite spend must not collapse to $0.00.
    expect(routingText).not.toMatch(/flash-lite[\s\S]{0,80}\$0\.00/);
    expect(routingText).toMatch(/flash-lite[\s\S]{0,120}\$0\.0[01]/);
    // Spend-over-time chart: stacked segments, legend, tooltip titles.
    const spendChart = page.locator(".analytics-spend-chart");
    await spendChart.waitFor();
    expect(await spendChart.locator(".analytics-spend-segment").count()).toBeGreaterThan(0);
    expect(await spendChart.locator(".analytics-spend-legend").textContent()).toMatch(/gemini|glm|unattributed|other/i);
    expect(await spendChart.locator(".analytics-spend-segment[title]").count()).toBeGreaterThan(0);
    expect(await spendChart.textContent()).toMatch(/daily buckets|hourly buckets/);
    // 7d uses daily labels; switching to 24h keeps the chart and switches granularity copy.
    const periodSelect = page.getByLabel("Analytics time window");
    await periodSelect.click();
    await page.getByRole("option", { name: "24 hours" }).click();
    await expect.poll(async () => page.locator(".analytics-spend-chart").textContent()).toMatch(/hourly buckets/);
    expect(await page.locator(".analytics-spend-chart .analytics-spend-segment").count()).toBeGreaterThan(0);
    await periodSelect.click();
    await page.getByRole("option", { name: "7 days" }).click();
    await expect.poll(async () => page.locator(".analytics-spend-chart").textContent()).toMatch(/daily buckets/);
    if (process.env.DASHBOARD_SCREENSHOTS) {
      await page.screenshot({ path: "/tmp/memracer-task-372-team-desktop-light.png", fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: "/tmp/memracer-task-372-team-mobile-light.png", fullPage: true });
      await page.evaluate(() => { localStorage.setItem("memracer.react.theme", "dark"); document.documentElement.setAttribute("data-theme", "dark"); });
      await page.screenshot({ path: "/tmp/memracer-task-372-team-mobile-dark.png", fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: "/tmp/memracer-task-372-team-desktop-dark.png", fullPage: true });
      await page.evaluate(() => { localStorage.setItem("memracer.react.theme", "light"); document.documentElement.setAttribute("data-theme", "light"); });
    }
    await page.getByRole("link", { name: "Project settings", exact: true }).click();
    await page.getByRole("heading", { name: "Project settings", exact: true }).waitFor();
    await page.locator(".people-panel .ui-avatar").first().waitFor();
    expect(await page.locator(".people-panel").textContent()).toContain("Joined Jul 15, 2026");
    expect(await page.locator(".people-panel .ui-avatar").count()).toBeGreaterThan(0);
    expect(await page.locator(".people-panel .access-role").count()).toBeGreaterThan(0);
    expect(await page.locator(".people-panel .access-role").evaluateAll((badges) => badges.every((badge) => {
      const badgeBox = badge.getBoundingClientRect();
      const panelBox = badge.closest(".people-panel")!.getBoundingClientRect();
      return badgeBox.right <= panelBox.right - 8;
    }))).toBe(true);
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-302-team-light-1440.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator(".people-panel .access-role").evaluateAll((badges) => badges.every((badge) => {
      const badgeBox = badge.getBoundingClientRect();
      const panelBox = badge.closest(".people-panel")!.getBoundingClientRect();
      return badgeBox.right <= panelBox.right - 8;
    }))).toBe(true);
    if (process.env.DASHBOARD_SCREENSHOTS) {
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      await page.screenshot({ path: "/tmp/memracer-task-302-team-light-390.png", fullPage: true });
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await page.screenshot({ path: "/tmp/memracer-task-302-team-dark-390.png", fullPage: true });
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(".people-panel .access-role").first().hover();
    await page.getByRole("tooltip").waitFor();
    expect(await page.getByRole("tooltip").textContent()).toContain("Project");
    expect(await page.locator(".settings-view select").count()).toBe(0);
    expect(await page.locator(".settings-view .identity-mark, .settings-view [data-identity-mark]").count()).toBe(0);
    expect(await page.locator(".settings-view pre:not(.setup-snippet):not(.setup-instructions)").count()).toBe(0);
    expect(await page.locator(".settings-view").textContent()).not.toMatch(/queryKey|isPending|endpoint|undefined|null|api\/p\//);
    await page.getByRole("combobox", { name: "Invite role" }).click();
    expect(await page.getByRole("listbox", { name: "Invite role" }).getByRole("option").allTextContents()).toEqual(["human", "coder", "admin"]);
    await page.keyboard.press("Escape");

    // Stub the clipboard before exercising any copy action.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: (value: string) => {
          (window as typeof window & { __memracerCopied?: string }).__memracerCopied = value;
          return Promise.resolve();
        } },
      });
    });
    const copied = () => page.evaluate(() => (window as typeof window & { __memracerCopied?: string }).__memracerCopied);
    // Add a seat: the single onboarding path is a generated prompt carrying a
    // `memracer enroll` token — never a raw MCP server config to paste.
    await page.getByRole("button", { name: "Generate human onboarding prompt" }).click();
    await page.locator(".setup-reveal").waitFor();
    const enrollPrompt = (await page.locator('[data-testid="roster-prompt"]').textContent()) ?? "";
    expect(enrollPrompt).toContain("memracer enroll");
    expect(enrollPrompt).not.toContain("claude mcp add");
    expect(enrollPrompt).not.toContain("memracer.com/mcp");
    const revealText = (await page.locator(".setup-reveal").textContent()) ?? "";
    expect(revealText).toContain("Shown once");
    expect(revealText).toContain("15 minutes");
    await page.getByRole("button", { name: "Copy prompt" }).click();
    expect(await copied()).toBe(enrollPrompt);
    await page.getByRole("button", { name: "Close onboarding prompt" }).click();
    expect(await page.locator(".setup-reveal").count()).toBe(0);
    // The seat LIST is exercised with a directly-seeded seat row: minting now
    // hands out an enrollment grant, not a named key, so there is no UI mint to
    // create the row through.
    const operatorId = (await dbRef.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>(EMAIL))!.id;
    await seedProjectSeat(dbRef, { userId: operatorId, name: "agent seat", projectId: "raceway", type: "human" });
    const keyRow = await dbRef.prepare('SELECT id, metadata FROM apikey WHERE name = ?').get<{ id: string; metadata: string }>("agent seat");
    await dbRef.prepare('UPDATE apikey SET "createdAt" = ?, "lastRequest" = ? WHERE id = ?')
      .run("2026-07-15T12:03:07.245Z", "2026-07-27T15:22:28.811Z", keyRow!.id);
    await page.reload();
    await page.getByRole("heading", { name: "Project settings", exact: true }).waitFor();
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: (value: string) => {
          (window as typeof window & { __memracerCopied?: string }).__memracerCopied = value;
          return Promise.resolve();
        } },
      });
    });
    const renderedKey = page.locator(".token-row").filter({ hasText: "agent seat" });
    await renderedKey.waitFor();
    await expect.poll(() => renderedKey.textContent()).toContain("Jul 15, 2026");
    await expect.poll(() => renderedKey.textContent()).toContain("Jul 27, 2026");
    expect(await page.getByRole("table", { name: "Seats" }).count()).toBe(1);
    expect(await renderedKey.getByRole("cell").count()).toBe(6);
    expect(await renderedKey.textContent()).toContain("Human");
    expect(await renderedKey.textContent()).toContain(keyRow!.id.slice(0, 8));
    expect(await renderedKey.textContent()).not.toContain("Never");
    await page.locator("details.org-directory > summary").click();
    expect(await page.locator("details.org-directory").textContent()).toContain("People across every Project in this organization.");
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-211-team-desktop.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-219-after-team.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-180-api-key-seats-desktop.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-236-after-1440.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator(".settings-view").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.locator(".token-panel").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-236-after-390.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-180-api-key-seats-mobile.png", fullPage: true });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-211-team-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });

    await chooseSelect("Invite role", "human");
    await page.getByLabel("Invite by email").fill("member-invite@example.com");
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect.poll(async () => (await dbRef.prepare('SELECT role FROM "invitation" WHERE email = ?').get<{ role: string }>("member-invite@example.com"))?.role).toBe("human");
    expect(await page.locator(".invite-row").filter({ hasText: "member-invite@example.com" }).textContent()).not.toContain("human");
    const inviteReveal = page.locator(".secret-reveal").filter({ hasText: "Join link" });
    const inviteValue = await inviteReveal.locator("input").inputValue();
    await inviteReveal.getByRole("button", { name: "Copy" }).click();
    expect(await copied()).toBe(inviteValue);

    await chooseSelect("Project", "Empty Project");
    await page.locator(".settings-view").waitFor();
    expect(await page.locator(".setup-reveal").count()).toBe(0);
    await chooseSelect("Project", "Signal Raceway");
    await page.locator(".settings-view").waitFor();
    await page.locator(".token-row").filter({ hasText: "agent seat" }).getByRole("button", { name: "Revoke" }).click();
    const revokeDialog = page.getByRole("alertdialog", { name: "Confirm revoke agent seat" });
    await revokeDialog.waitFor();
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toContain("Confirm revoke");
    expect(await dbRef.prepare("SELECT id FROM apikey WHERE id = ?").get(keyRow!.id)).toBeTruthy();
    await page.getByRole("button", { name: "Confirm revoke" }).click();
    await expect.poll(async () => Boolean(await dbRef.prepare("SELECT id FROM apikey WHERE id = ?").get(keyRow!.id))).toBe(false);

    await page.getByRole("button", { name: "Open command palette" }).click();
    const command = page.getByRole("dialog", { name: "Go to" });
    await command.getByRole("combobox").fill("Empty Project");
    expect(await command.getByRole("button", { name: "Factory Org · Empty Project" }).count()).toBe(1);
    await command.getByRole("combobox").fill("");
    await command.getByRole("combobox").press("ArrowDown");
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toContain("Operations");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("aria-label"))).toBe("Open command palette");

    await page.evaluate(() => localStorage.removeItem("memracer.react.mobile-tab"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard`);
    const mobile = page.getByRole("navigation", { name: "Mobile views" });
    await expect.poll(() => mobile.getByRole("button").allTextContents()).toEqual(["You", "Activity", "Queue", "Knowledge", "Team analytics", "Settings"]);
    expect(await mobile.getByRole("button", { name: "You" }).getAttribute("aria-current")).toBe("page");
    await page.locator(".you-surface").waitFor({ state: "visible" });
    await mobile.getByRole("button", { name: "Activity" }).click();
    await page.locator(".feed-surface").waitFor({ state: "visible" });
    await mobile.getByRole("button", { name: "Queue" }).click();
    await page.locator(".queue-panel").waitFor({ state: "visible" });
    await mobile.getByRole("button", { name: "You" }).click();
    await page.locator(".you-surface").waitFor({ state: "visible" });
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-164-information-architecture-mobile.png", fullPage: true });
    await page.getByRole("navigation", { name: "Mobile views" }).getByRole("button", { name: "Knowledge" }).click();
    await page.getByRole("heading", { name: "Knowledge activity" }).waitFor();
    expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }, 60_000);

  it("keeps the Knowledge explorer compact, drillable, and axe-clean", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=knowledge`);
    await page.getByRole("heading", { name: "Knowledge activity" }).waitFor();
    const surface = page.locator(".knowledge-view");
    expect(await surface.getByRole("heading", { name: "Explorer" }).count()).toBe(1);
    expect(await surface.locator("select").count()).toBe(0);
    expect(await surface.locator('[data-identity-key]:not(.ui-avatar)').count()).toBe(0);
    expect(await surface.locator(":scope > pre, .knowledge-reader > pre, .knowledge-reader > code").count()).toBe(0);
    expect(await surface.textContent()).not.toContain("Maintained by the steward");
    expect(await surface.textContent()).not.toContain("curated@");
    expect(await knowledgeAccessibilityViolations()).toEqual([]);

    const product = page.getByRole("tree", { name: "Knowledge concepts" }).getByRole("treeitem", { name: /Product framing/ });
    await product.click();
    await page.locator(".knowledge-body h1").waitFor();
    expect(await page.getByRole("navigation", { name: "Concept path" }).getByText("product-framing.md").getAttribute("aria-current")).toBe("page");
    expect(await surface.locator(".knowledge-body pre code").textContent()).toBe("pnpm test\n");
    expect(await surface.locator(":scope > pre, .knowledge-reader > pre, .knowledge-reader > code").count()).toBe(0);
    expect(await knowledgeAccessibilityViolations()).toEqual([]);
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-234-after-desktop.png", fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await surface.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.locator(".knowledge-body").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await knowledgeAccessibilityViolations()).toEqual([]);
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-234-after-mobile.png", fullPage: true });

    await page.locator(".knowledge-back").click();
    await expect.poll(() => new URL(page.url()).searchParams.get("concept")).toBeNull();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-knowledge-path"))).toBe("decisions/product-framing.md");
    expect(await page.getByRole("tree", { name: "Knowledge concepts" }).isVisible()).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }, 60_000);

  it("clears the Knowledge document when switching Projects", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=knowledge`);
    const reader = page.locator(".knowledge-reader");
    const product = page.getByRole("tree", { name: "Knowledge concepts" }).getByRole("treeitem", { name: /Product framing/ });
    await product.click();
    await reader.locator(".knowledge-body h1").waitFor();

    expect(new URL(page.url()).searchParams.get("concept")).toBe("decisions/product-framing.md");
    expect(await page.locator(".knowledge-view").getAttribute("class")).toContain("is-reading");
    expect(await reader.locator(".knowledge-document-header").count()).toBe(1);

    await chooseSelect("Project", "Empty Project");
    await expect.poll(() => new URL(page.url()).searchParams.get("project")).toBe("empty");
    await expect.poll(() => new URL(page.url()).searchParams.get("concept")).toBeNull();
    await reader.getByRole("heading", { name: "Knowledge activity" }).waitFor();

    expect(await page.locator(".knowledge-view").getAttribute("class")).not.toContain("is-reading");
    expect(await reader.locator(".knowledge-document-header, .knowledge-body, .knowledge-provenance").count()).toBe(0);
    expect(await reader.textContent()).not.toContain("Operating model");
  }, 60_000);

  it("keeps Project health geometry stable across loading, empty, and error", async () => {
    const statePage = await context.newPage();
    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    await statePage.route("**/api/p/empty/queue**", async (route) => {
      await queueGate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tasks: [] }) });
    });
    try {
      await statePage.goto(`${baseUrl}/dashboard/?project=empty&view=dashboard`);
      const status = statePage.locator(".status-band");
      await status.locator('[data-query-view="loading"]').waitFor();
      const loadingHeight = (await status.boundingBox())!.height;
      releaseQueue();
      await status.locator('[data-query-view="empty"]').waitFor();
      const emptyHeight = (await status.boundingBox())!.height;
      expect(emptyHeight).toBe(loadingHeight);
      expect(await status.textContent()).toContain("No project readings yet.");
    } finally {
      releaseQueue();
      await statePage.close();
    }

    const errorPage = await context.newPage();
    await errorPage.route("**/api/p/empty/queue**", (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "unavailable" }),
    }));
    try {
      await errorPage.goto(`${baseUrl}/dashboard/?project=empty&view=dashboard`);
      const status = errorPage.locator('.status-band[data-query-view="error"]');
      await status.waitFor();
      expect(await status.textContent()).toContain("Project readings temporarily unavailable.");
      expect((await status.boundingBox())!.height).toBeGreaterThanOrEqual(106);
      expect((await status.boundingBox())!.height).toBeLessThanOrEqual(108);
    } finally {
      await errorPage.close();
    }
  });

  it("keeps Team controls usable when invites and setup config fail", async () => {
    const configPattern = "**/api/config";
    const invitesPattern = "**/api/p/raceway/invites";
    await page.route(configPattern, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }));
    await page.route(invitesPattern, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }));
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${baseUrl}/dashboard/?project=raceway&view=settings`);
      await page.locator(".settings-view").waitFor({ timeout: 3_000 });
      const invitesError = page.locator(".people-panel .surface-error").filter({ hasText: "Pending invites unavailable." });
      await invitesError.waitFor({ timeout: 3_000 });
      expect(await invitesError.getByRole("button", { name: "Retry" }).count()).toBe(1);

      // Seats stay usable while /api/config and invites are down: the onboarding
      // prompt is built server-side, so generating one does not depend on config.
      expect(await page.locator('[data-testid="roster-panel"]').getByRole("heading", { name: "Add a seat" }).count()).toBe(1);
      await page.getByRole("button", { name: "Generate coder onboarding prompt" }).click();
      await page.locator(".setup-reveal").waitFor({ timeout: 3_000 });
      expect(await page.locator(".setup-reveal .setup-snippet").textContent()).toContain("memracer enroll");
    } finally {
      await page.unroute(configPattern);
      await page.unroute(invitesPattern);
    }
  }, 20_000);

  it("surfaces GitHub connection setup and the selected Project repository", async () => {
    const statusPattern = "**/api/orgs/factory-org/github";
    let status: Record<string, unknown> = {
      configured: false,
      linked: false,
      installation: null,
      repositories: [],
    };
    await page.route(statusPattern, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(status),
    }));
    const teamUrl = `${baseUrl}/dashboard/?project=raceway&view=settings`;
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(() => localStorage.setItem("memracer.react.theme", "light"));
      await page.goto(teamUrl);
      const panel = page.locator(".github-connection-panel");
      await panel.getByRole("heading", { name: "GitHub connection" }).waitFor();
      await panel.getByText("Not configured", { exact: true }).waitFor();
      expect(await panel.textContent()).toContain("MEMRACER_GITHUB_APP_SLUG");
      expect(await panel.textContent()).toContain("docs/github-app.md");
      const repository = panel.getByRole("link", { name: "Open recallnet/memracer on GitHub" });
      expect(await repository.getAttribute("href")).toBe("https://github.com/recallnet/memracer");
      expect(await repository.getAttribute("target")).toBe("_blank");
      if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-317-light-1440.png", fullPage: true });

      status = { configured: true, linked: false, installation: null, repositories: [] };
      await page.reload();
      await panel.getByRole("button", { name: "Link GitHub" }).waitFor();

      status = { configured: true, linked: true, installation: null, repositories: [] };
      await page.reload();
      await panel.getByRole("button", { name: "Install GitHub App" }).waitFor();

      status = {
        configured: true,
        linked: true,
        installation: { id: "77", accountLogin: "recallnet", repositorySelection: "selected" },
        repositories: [{ id: "501", name: "memracer", fullName: "recallnet/memracer", private: true }],
      };
      await page.evaluate(() => localStorage.setItem("memracer.react.theme", "dark"));
      await page.reload();
      await panel.getByText("Connected", { exact: true }).waitFor();
      expect(await panel.textContent()).toContain("1 selected repository available.");
      status = {
        configured: true,
        linked: true,
        installation: { id: "77", accountLogin: "recallnet", repositorySelection: "all" },
        repositories: [{ id: "501", name: "memracer", fullName: "recallnet/memracer", private: true }],
      };
      await page.reload();
      await panel.getByText("All repositories available to this installation.", { exact: true }).waitFor();
      expect(await panel.textContent()).toContain("All repositories available to this installation.");
      if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-317-dark-1440.png", fullPage: true });

      await page.setViewportSize({ width: 390, height: 844 });
      expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-317-dark-390.png", fullPage: true });
    } finally {
      await page.evaluate(() => localStorage.removeItem("memracer.react.theme")).catch(() => undefined);
      await page.unroute(statusPattern);
    }
  }, 60_000);

  it("creates a Project from one GitHub App-selected repository", async () => {
    const statusPattern = "**/api/orgs/factory-org/github";
    const createPattern = "**/api/orgs/factory-org/github/projects";
    let releaseStatus!: () => void;
    const statusReady = new Promise<void>((resolve) => { releaseStatus = resolve; });
    let submitted: unknown;
    await page.route(statusPattern, async (route) => {
      await statusReady;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          configured: true,
          linked: true,
          installation: { id: "77", accountLogin: "recallnet", repositorySelection: "selected" },
          repositories: [
            { id: "501", name: "memracer", fullName: "recallnet/memracer", private: true },
            { id: "502", name: "other", fullName: "recallnet/other", private: false },
          ],
        }),
      });
    });
    await page.route(createPattern, async (route) => {
      submitted = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "raceway", name: "GitHub Project", repo: "recallnet/memracer" }),
      });
    });
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard`);
      await page.locator(".project-create-menu > summary").click();
      const github = page.locator(".project-create-popover .github-project-create");
      await github.getByRole("heading", { name: "GitHub repository" }).waitFor();
      await github.getByText("Loading GitHub connection…").waitFor();
      releaseStatus();
      await expect.poll(() => github.textContent()).toContain("Connected to recallnet");
      await github.getByLabel("Project name").fill("GitHub Project");
      await github.getByRole("combobox", { name: "GitHub repository" }).click();
      await page.getByRole("option", { name: "recallnet/memracer", exact: true }).click();
      await github.getByRole("button", { name: "Create from GitHub" }).click();
      await expect.poll(() => submitted).toEqual({ name: "GitHub Project", repositoryId: "501" });
      expect(await github.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);

      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.locator(".project-create-popover").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    } finally {
      releaseStatus();
      await page.unroute(statusPattern);
      await page.unroute(createPattern);
    }
  });

  it("restores saved Knowledge and Team tabs when resizing through the mobile breakpoint", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => localStorage.setItem("memracer.react.mobile-tab", "knowledge"));
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard`);
    await page.locator("#raceway-title").waitFor();
    expect(new URL(page.url()).searchParams.get("view")).toBe("dashboard");
    await page.setViewportSize({ width: 800, height: 844 });
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("knowledge");
    await page.getByRole("heading", { name: "Knowledge activity" }).waitFor();
    expect(await page.getByRole("navigation", { name: "Mobile views" }).getByRole("button", { name: "Knowledge" }).getAttribute("aria-current")).toBe("page");
    expect(await page.locator(".knowledge-view").isVisible()).toBe(true);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => localStorage.setItem("memracer.react.mobile-tab", "team"));
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard`);
    await page.locator("#raceway-title").waitFor();
    expect(new URL(page.url()).searchParams.get("view")).toBe("dashboard");
    await page.setViewportSize({ width: 800, height: 844 });
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("team");
    await page.locator(".team-analytics-view").waitFor();
    expect(await page.getByRole("navigation", { name: "Mobile views" }).getByRole("button", { name: "Team analytics" }).getAttribute("aria-current")).toBe("page");
    expect(await page.locator(".team-analytics-view").isVisible()).toBe(true);

    await page.setViewportSize({ width: 1440, height: 1000 });
  }, 20_000);

  it("shows project administration only to an admin and rejects a non-admin delete", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=settings`);
    await page.locator(".settings-view").waitFor();
    expect(await page.getByRole("button", { name: "Delete Project" }).count()).toBe(1);
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-179-admin-team.png", fullPage: true });

    const memberContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const memberPage = await memberContext.newPage();
    try {
      await memberPage.goto(`${baseUrl}/signin`);
      await memberPage.locator("#email").fill(MEMBER_EMAIL);
      await memberPage.locator("#submit").click();
      const memberMagicLink = new URL(latestMagicLink(MEMBER_EMAIL));
      memberMagicLink.host = new URL(baseUrl).host;
      await memberPage.goto(memberMagicLink.toString());
      await memberPage.locator(".dashboard-shell").waitFor({ state: "visible" });
      await memberPage.goto(`${baseUrl}/dashboard/?project=raceway&view=settings`);
      await memberPage.locator(".settings-view").waitFor();
      expect(await memberPage.getByRole("button", { name: "Delete Project" }).count()).toBe(0);
      expect(await memberPage.getByLabel("Invite role").count()).toBe(0);
      const deleteStatus = await memberPage.evaluate(async () => (await fetch("/api/p/raceway", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Signal Raceway" }),
      })).status);
      expect(deleteStatus).toBe(403);
      if (process.env.DASHBOARD_SCREENSHOTS) await memberPage.screenshot({ path: "/tmp/memracer-task-179-member-team.png", fullPage: true });
    } finally {
      await memberContext.close();
    }
  }, 20_000);

  it("keeps the dashboard mounted while a session stream reconnects after 503", async () => {
    let failures = 1;
    const streamPattern = `**/api/p/raceway/sessions/${timelineRootThreadId}/stream`;
    const manifestPattern = "**/dashboard/manifest.json";
    await page.route(manifestPattern, (route) => route.fulfill({ status: 503, contentType: "text/plain", body: "temporarily unavailable" }));
    await page.route(streamPattern, async (route) => {
      if (failures > 0) {
        failures -= 1;
        await route.fulfill({ status: 503, contentType: "text/plain", body: "temporarily unavailable" });
        return;
      }
      await route.continue();
    });
    try {
      await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&thread=${timelineRootThreadId}`);
      await page.getByText("Activity reconnecting…", { exact: true }).waitFor();
      expect(await page.locator(".dashboard-shell").isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Open command palette" }).isEnabled()).toBe(true);
      expect(await page.evaluate(async () => (await fetch("/dashboard/manifest.json")).status)).toBe(503);
      expect(await page.locator(".dashboard-shell").isVisible()).toBe(true);
      if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-181-stream-reconnecting.png", fullPage: true });
      await page.locator('.aui-msg[data-event-id]').first().waitFor({ timeout: 10_000 });
      await expect.poll(() => page.getByText("Activity reconnecting…", { exact: true }).count()).toBe(0);
      expect(failures).toBe(0);
    } finally {
      await page.unroute(streamPattern);
      await page.unroute(manifestPattern);
    }
  }, 20_000);

  it("keeps last-good queue data and other controls interactive across API 503", async () => {
    let failQueue = false;
    const queuePattern = "**/api/p/raceway/queue";
    await page.route(queuePattern, async (route) => {
      if (failQueue) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporarily unavailable" }) });
        return;
      }
      await route.continue();
    });
    try {
      await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard`);
      await page.getByText("Unwedge merge queue", { exact: true }).first().waitFor();
      failQueue = true;
      await queueRef.submit("raceway", "Operator", { title: "Recovered after queue 503", body: "", evidence: [] });
      const warning = page.locator(".queue-panel .query-notice");
      await warning.waitFor({ timeout: 10_000 });
      expect(await warning.textContent()).toContain("Showing the last update");
      expect(await page.getByText("Unwedge merge queue", { exact: true }).first().isVisible()).toBe(true);
      await page.getByRole("button", { name: "Open command palette" }).click();
      await page.getByRole("dialog", { name: "Go to" }).waitFor();
      await page.getByRole("button", { name: "Close command palette" }).click();
      if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-181-queue-error.png", fullPage: true });
      failQueue = false;
      await warning.getByRole("button", { name: "Retry" }).click();
      await page.getByText("Recovered after queue 503", { exact: true }).first().waitFor();
      await expect.poll(() => warning.count()).toBe(0);
    } finally {
      await page.unroute(queuePattern);
    }
  }, 20_000);

  it("refreshes the canonical queue over SSE and recovers after deleting the selected project", async () => {
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard`);
    await page.locator("#raceway-title").waitFor();
    const marker = await page.evaluate(() => performance.getEntriesByType("navigation").length);
    await queueRef.submit("raceway", "Operator", { title: "Arrived over SSE", body: "", evidence: [] });
    await page.getByText("Arrived over SSE", { exact: true }).first().waitFor();
    expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(marker);

    await page.goto(`${baseUrl}/dashboard/?project=empty&view=settings`);
    await page.locator(".settings-view").waitFor();
    await page.getByRole("button", { name: "Delete Project" }).click();
    const dialog = page.getByRole("dialog", { name: "Archive Empty Project" });
    await dialog.getByLabel("Project name").fill("Empty Project");
    await dialog.getByRole("button", { name: "Archive Project" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("project")).toBe("raceway");
    await page.locator(".settings-view").waitFor();
    expect((await fetch(`${baseUrl}/dashboard/next/`)).status).toBe(404);
  }, 60_000);

  it("exposes named controls, keyboard focus, and no serious WCAG violations", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard`);
    await page.locator(".feed-surface").waitFor();
    await page.getByRole("navigation", { name: "Project threads" }).waitFor();
    expect(await page.getByRole("heading", { level: 1, name: "Operations" }).count()).toBe(1);

    const activityButtons = page.getByRole("navigation", { name: "Project threads" }).getByRole("button");
    expect(await activityButtons.count()).toBeGreaterThan(0);
    for (const button of await activityButtons.all()) {
      expect(await button.evaluate((node) => Boolean(node.textContent?.trim()))).toBe(true);
    }
    await activityButtons.first().focus();
    expect(await activityButtons.first().evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");
    expect(await seriousAccessibilityViolations()).toEqual([]);
    const taskTrigger = page.locator(".queue-task-trigger").first();
    await taskTrigger.click();
    await page.getByRole("dialog", { name: /^Task / }).waitFor();
    expect(await page.getByRole("region", { name: "Session replay controls" }).count()).toBe(0);
    expect(await seriousAccessibilityViolations()).toEqual([]);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".task-sheet").count()).toBe(0);

    await page.getByRole("link", { name: "Knowledge", exact: true }).click();
    await page.getByRole("heading", { name: "Knowledge activity" }).waitFor();
    const knowledgeRows = page.locator(".knowledge-row-main");
    expect(await knowledgeRows.count()).toBeGreaterThan(0);
    for (const button of await knowledgeRows.all()) {
      expect(await button.evaluate((node) => Boolean(node.textContent?.trim()))).toBe(true);
    }
    const treeRows = page.getByRole("tree", { name: "Knowledge concepts" }).getByRole("treeitem");
    await treeRows.first().focus();
    const firstFocused = await page.evaluate(() => document.activeElement?.textContent);
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).not.toBe(firstFocused);
    expect(await seriousAccessibilityViolations()).toEqual([]);

    const paletteTrigger = page.getByRole("button", { name: "Open command palette" });
    await paletteTrigger.click();
    const palette = page.getByRole("dialog", { name: "Go to" });
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("combobox");
    const close = palette.getByRole("button", { name: "Close command palette" });
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest(".command-results") != null)).toBe(true);
    expect(await seriousAccessibilityViolations()).toEqual([]);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Open command palette");
    await page.getByRole("link", { name: "Team analytics", exact: true }).click();
    await page.locator(".team-analytics-view").waitFor();
    expect(await seriousAccessibilityViolations()).toEqual([]);
  }, 60_000);

  it("keeps shell navigation explicit, persistent, and usable at mobile width", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard`);
    const sidebar = page.getByRole("complementary", { name: "Dashboard navigation" });
    await sidebar.waitFor();
    expect(await sidebar.getByRole("link", { name: "Operations" }).getAttribute("aria-current")).toBe("page");
    const desktopOpen = page.locator(".queue-table-wrap").getByRole("button", { name: "Open", exact: true });
    if (await desktopOpen.count()) expect(await desktopOpen.first().isVisible()).toBe(true);

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    expect(await page.locator(".dashboard-shell").getAttribute("data-sidebar-collapsed")).toBe("true");
    await page.reload();
    await expect.poll(() => page.locator(".dashboard-shell").getAttribute("data-sidebar-collapsed")).toBe("true");
    await page.getByRole("button", { name: "Expand sidebar" }).click();

    await sidebar.locator(".account-menu > summary").click();
    expect(await sidebar.getByRole("button", { name: "Settings" }).isVisible()).toBe(true);
    expect(await sidebar.getByLabel("Switch project").count()).toBe(1);
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-226-shell-desktop.png", fullPage: true });
    await sidebar.locator(".account-menu > summary").click();

    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(".shell-sidebar.is-open").waitFor();
    if (process.env.DASHBOARD_SCREENSHOTS) await page.screenshot({ path: "/tmp/memracer-task-226-shell-mobile.png", fullPage: true });
    await sidebar.getByRole("button", { name: "Close navigation" }).click();
    await expect.poll(() => page.locator(".shell-sidebar.is-open").count()).toBe(0);
    await expect.poll(() => page.locator(".sidebar-scrim").count()).toBe(0);
    expect(await page.locator(".shell-sidebar").getAttribute("inert")).not.toBeNull();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Open navigation");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(".shell-sidebar.is-open").getByRole("link", { name: "Knowledge" }).click();
    await expect.poll(() => page.locator(".shell-sidebar.is-open").count()).toBe(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Open navigation");
    expect(await page.locator(".page-header h1:visible").count()).toBe(1);
    expect(await seriousAccessibilityViolations()).toEqual([]);
  }, 60_000);

  it("renders a real coder seat name while the verified key id owns the lease", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseUrl}/dashboard/?project=raceway&view=settings`);
    await page.locator(".settings-view").waitFor();
    const seat = await page.evaluate(async () => {
      const response = await fetch("/api/p/raceway/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Readable Browser Coder", type: "coder" }),
      });
      if (!response.ok) throw new Error(`key creation failed: ${response.status}`);
      return response.json() as Promise<{ id: string; key: string; name: string }>;
    });
    const taskId = await queueRef.submit("raceway", "Operator", {
      title: "Show the real coder seat",
      body: "Keep the verified key id in storage and present the readable seat name.",
      priority: 0,
      evidence: [],
    });
    const coder = await connectCoder(seat.key);
    try {
      expect(parseTool(await coder.callTool({
        name: "coder_claim_task",
        arguments: { project: "raceway" },
      }))).toMatchObject({ id: taskId, lease_agent: "Operator-Readable Browser Coder" });
      expect(await dbRef.prepare("SELECT lease_agent FROM tasks WHERE id = ?").get(taskId)).toEqual({
        lease_agent: seat.id,
      });
      await coder.callTool({
        name: "coder_block",
        arguments: { task_id: taskId, reason: "Confirm retry ownership" },
      });
      const question = await dbRef
        .prepare("SELECT id FROM questions WHERE task_id = ? AND asked_by = ?")
        .get<{ id: number }>(taskId, seat.id);
      await queueRef.answerQuestion(question!.id, "Retry", "Operator");
      expect(parseTool(await coder.callTool({
        name: "coder_claim_task",
        arguments: { project: "raceway" },
      }))).toMatchObject({ id: taskId, lease_agent: "Operator-Readable Browser Coder" });

      await page.goto(`${baseUrl}/dashboard/?project=raceway&view=dashboard&task=${taskId}`);
      const sheet = page.locator(".task-sheet");
      await sheet.waitFor();
      expect(await sheet.locator('.task-summary-status [data-actor-role="coder"]').textContent()).toContain("Operator-Readable Browser Coder");
      expect(await sheet.locator('.attempt-row [data-actor-role="coder"]').textContent()).toContain("Operator-Readable Browser Coder");
      expect(await sheet.locator('.question-row [data-actor-role="coder"]').textContent()).toContain("Operator-Readable Browser Coder");
      expect(await sheet.textContent()).not.toContain(seat.id);
    } finally {
      await coder.close();
    }
  }, 60_000);
});
