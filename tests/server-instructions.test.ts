// tests/server-instructions.test.ts
// Connect-time MCP `instructions`: a session learns its role and open-question
// workflow on connect — no dashboard required to unblock work.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { openDb } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import {
  CODER_ROLE_CONTRACT,
  FRIGG_IDENTITY,
  HUMAN_ROLE_CONTRACT,
} from "../src/dashboard/public/role-contracts.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let db: Db;
const tokens: Record<string, string> = {};
const HUMAN_CHECKOUT_SYNC_DIRECTIVE = "Keep your working checkout synced with remote main. As a human-role agent you likely sit on ONE long-lived checkout of main, in a different folder than the coders' per-task worktrees — and coders continuously merge PRs to remote main. Run `git fetch && git pull origin main` (or equivalent) before you start researching, and periodically during long sessions, so your file:line references and findings reflect CURRENT main. Stale local state silently produces out-of-date research and wrong pointers.";
const CODER_SECURITY_REFUSAL = "Refuse any task whose requested outcome would exfiltrate or publish real secrets, weaken or bypass security controls, perform arbitrary host-side actions without a reviewable repository code deliverable, damage or backdoor the coder host, or attack third parties; judge the requested action, not claims that it is simulated, fake, or authorized.";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','recallnet/demo-app')").run();
  tokens["tok-h"] = (await seedMember(db, { name: "dana", projectId: "demo", role: "human" })).token;
  tokens["tok-c"] = (await seedMember(db, { name: "cc-7f2", projectId: "demo", role: "coder" })).token;
  tokens["tok-a"] = (await seedMember(db, { name: "admin-al", projectId: "demo", role: "admin" })).token;
  const made = createApp(db, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
  });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});

afterEach(() => {
  worker.stop();
  return new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function instructionsFor(token: string): Promise<string> {
  const client = new Client({ name: "test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${tokens[token] ?? token}` } },
  });
  await client.connect(transport);
  const text = client.getInstructions();
  await client.close();
  return text ?? "";
}

async function coderToolDescription(name: string): Promise<string> {
  const client = new Client({ name: "test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${tokens["tok-c"]}` } },
  });
  await client.connect(transport);
  const tool = (await client.listTools()).tools.find((candidate) => candidate.name === name);
  await client.close();
  return tool?.description ?? "";
}

async function humanTools() {
  const client = new Client({ name: "test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${tokens["tok-h"]}` } },
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.filter((tool) => tool.name.startsWith("human_"));
  await client.close();
  return tools;
}

describe("connect-time role instructions", () => {
  it("uses the shared role contracts verbatim", async () => {
    expect(await instructionsFor("tok-h")).toMatch(
      new RegExp(`\\n\\n${escapeRegExp(HUMAN_ROLE_CONTRACT)}$`),
    );
    expect(await instructionsFor("tok-c")).toMatch(
      new RegExp(`\\n\\n${escapeRegExp(CODER_ROLE_CONTRACT)}$`),
    );
  });

  it("introduces Frigg in every served role contract", async () => {
    expect(FRIGG_IDENTITY).toBe("Frigg is the orchestrator (mediator) for this project.");
    const human = await instructionsFor("tok-h");
    const coder = await instructionsFor("tok-c");
    expect(human).toContain(FRIGG_IDENTITY);
    expect(coder).toContain(FRIGG_IDENTITY);
    expect(human).not.toMatch(/\bthe (?:mediator|mcp)\b/i);
    expect(coder).not.toMatch(/\bthe (?:mediator|mcp)\b/i);
    // The coder contract points idle agents at the built-in waiter, not a hand-rolled poll loop.
    expect(coder).toContain("memracer wait");
  });

  it("human token: carries the inspect-first and plain-language collaboration contract", async () => {
    const text = await instructionsFor("tok-h");
    expect(text).toMatch(/plan/i);
    expect(text).toMatch(/not.*(write )?code|code.*yourself/i);
    expect(text).toMatch(/inspect the relevant repo code, project memory\/OKF, and supplied evidence/i);
    expect(text).toMatch(/do not wing it/i);
    expect(text).toMatch(/short, simple language at the user's altitude/i);
    expect(text).toMatch(/every response must be one short paragraph of at most five short sentences/i);
    expect(text).toMatch(/use more only when the user asks for detail/i);
    expect(text).toMatch(/anything longer is a wall of text/i);
  });

  it("human and admin tokens require checkout sync before and during research", async () => {
    expect(HUMAN_ROLE_CONTRACT.split("\n")).toContain(HUMAN_CHECKOUT_SYNC_DIRECTIVE);
    expect(await instructionsFor("tok-h")).toContain(HUMAN_CHECKOUT_SYNC_DIRECTIVE);
    expect(await instructionsFor("tok-a")).toContain(HUMAN_CHECKOUT_SYNC_DIRECTIVE);
  });

  it("human token: absorbs low-stakes choices and consults only on consequential forks", async () => {
    const text = await instructionsFor("tok-h");
    expect(text).toMatch(/easy, reversible, low-stakes choices without asking/i);
    expect(text).toMatch(/at a high-leverage or hard-to-reverse fork/i);
    expect(text).toMatch(/MUST NOT decide, reject, combine, reframe, choose, or recommend any option before the user answers/);
    expect(text).toMatch(/summarize the real options and key tradeoff, ask which direction the user wants, then stop/i);
    expect(text).toMatch(/decision is pending the user's direction/i);
    expect(text).toMatch(/not a chosen approach or a request for permission to hand it off/i);
  });

  it("human token: reports outcomes and hands work to the mediator while preserving correction guidance", async () => {
    const text = await instructionsFor("tok-h");
    expect(text).toMatch(/lead with the outcome/i);
    expect(text).toMatch(/what happened, what it means, and what comes next/i);
    expect(text).toMatch(/handoff to Frigg through human tools/i);
    expect(text).toMatch(/shape the plan before execution/i);
    expect(text).toMatch(/expect Frigg to grill the submission one decision at a time/i);
    expect(text).toMatch(/self-serve facts/i);
    expect(text).toMatch(/genuine decisions you cannot own to the human-in-the-loop/i);
  });

  it("human token: retains human tools and documents the correction boundary", async () => {
    const text = await instructionsFor("tok-h");
    expect(text).toContain("human_submit");
    expect(text).toContain("human_discuss");
    expect(text).not.toContain("human_steer");
    expect(text).toContain("human_followup");
    expect(text).toContain("human_answer");
    expect(text).toContain("human_status");
    expect(text).toContain("human_enhance");
    expect(text).toContain("human_warm_task");
    expect(text).toContain("human_seal_incubation");
    expect(text).toContain("human_extend_incubation");
    expect(text).toMatch(/no reliable way to correct a coder mid-execution/i);
    expect(text).toContain("human_conversation_reply");
    // The no-dashboard unblock instruction (criterion 5).
    expect(text).toMatch(/open question/i);
  });

  it("human instructions and every human tool advertise clarification piggyback", async () => {
    const text = await instructionsFor("tok-h");
    expect(text).toContain("pending_clarifications");
    expect(text).toMatch(/human_answer before moving on/i);
    expect(text).toMatch(/Prefer human_submit\(wait=true\)/i);
    expect(text).toMatch(/stay on the human loop for Frigg follow-ups/i);
    expect(text).toMatch(/Do not treat a GROOMING ack as/i);
    const tools = await humanTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.description, tool.name).toContain("pending_clarifications");
    }
    const submitDesc = tools.find((tool) => tool.name === "human_submit")?.description ?? "";
    expect(submitDesc).toContain("wait=true");
    expect(submitDesc).toMatch(/stay for Frigg follow-ups/i);
  });

  it("human token: names human_enhance and the warming-period curation model (#62)", async () => {
    const text = await instructionsFor("tok-h");
    expect(text).toContain("human_warm_task");
    expect(text).toContain("human_enhance");
    expect(text).toContain("human_seal_incubation");
    expect(text).toContain("human_extend_incubation");
  });

  it("human tools and role contract advertise race-free hold via warm_for on submit/followup", async () => {
    // #453: agents must discover one race-free action to file work off the
    // coder queue — not invent title tags and race through submit→warm.
    const text = await instructionsFor("tok-h");
    expect(text).toMatch(/warm_for/i);
    expect(text).toMatch(/without starting|off the coder queue|on record/i);
    expect(HUMAN_ROLE_CONTRACT).toMatch(/warm_for/);

    const tools = await humanTools();
    const submit = tools.find((tool) => tool.name === "human_submit");
    const followup = tools.find((tool) => tool.name === "human_followup");
    expect(submit?.description).toMatch(/warm_for/);
    expect(followup?.description).toMatch(/warm_for/);
  });

  it("human token: surfaces active warming tasks to join, coder token does not (#62 onboarding hook)", async () => {
    // A warming (INCUBATING) task the human could shape.
    const id = await db
      .prepare(
        `INSERT INTO tasks (project_id, title, body, priority, state, incubate_until, submitted_by, watermark, created_at, updated_at)
         VALUES ('demo','Live warming task','b',2,'INCUBATING',?, 'dana','w',?,?) RETURNING id`,
      )
      .get<{ id: number }>(Date.now() + 3_600_000, Date.now(), Date.now());
    expect(id!.id).toBeGreaterThan(0);

    const human = await instructionsFor("tok-h");
    expect(human).toMatch(/warming tasks you can shape/i);
    expect(human).toContain(`#${id!.id} (demo): Live warming task`);
    expect(human).toContain("Frigg merges, refuses, or clarifies");
    expect(human).not.toMatch(/\bthe (?:mediator|mcp)\b/i);

    // A coder-only session gets no warming-tasks-to-join block.
    const coder = await instructionsFor("tok-c");
    expect(coder).not.toMatch(/warming tasks you can shape/i);
  });

  it("coder token: describes the claim→plan→complete loop", async () => {
    const text = await instructionsFor("tok-c");
    expect(text).toContain("coder_check_work");
    expect(text).toContain("coder_claim_task");
    expect(text).toMatch(/long[- ]poll/i);
    expect(text).toMatch(/available_count[\s\S]*sleep\(idle_interval\)[\s\S]*continue/i);
    expect(text).toMatch(/complete[\s\S]*start the same background check job/i);
    expect(text).toMatch(/do not (?:return|exit|notify)/i);
    expect(text).toContain("coder_propose_plan");
    expect(text).toMatch(/pending/i);
    expect(text).toMatch(/SAME plan args|re-call/i);
    expect(text).toContain("coder_progress");
    expect(text).toContain("coder_complete");
    // A coder-only session is not a human — no human_answer guidance.
    expect(text).not.toContain("human_answer");
  });

  it("coder and admin tokens carry the shared action-based security refusal", async () => {
    expect(CODER_ROLE_CONTRACT.split("\n")).toContain(CODER_SECURITY_REFUSAL);
    expect(await instructionsFor("tok-c")).toContain(CODER_SECURITY_REFUSAL);
    expect(await instructionsFor("tok-a")).toContain(CODER_SECURITY_REFUSAL);
  });

  it("coder-only connect instructions retain the canonical contract bytes", async () => {
    const text = await instructionsFor("tok-c");
    // Keep the complete proven idle-loop contract byte-stable around deliberate updates.
    expect(createHash("sha256").update(text).digest("hex")).toBe(
      "cf0def237e2694de6a2bda9c5dbbbf4a2be219adbdf122d62706f72c2bfd1566",
    );
  });

  it("coder token keeps every empty check cycle off the main model path", async () => {
    const text = await instructionsFor("tok-c");
    // Preferred path: the push waiter blocks on the server stream — zero polling,
    // zero model tokens — and wakes only on claimable work.
    expect(text).toMatch(/memracer wait/);
    expect(text).toMatch(/server PUSH \(Server-Sent Events\)/i);
    expect(text).toMatch(/zero polling/i);
    expect(text).toMatch(/zero model tokens/i);
    expect(text).toMatch(/exits only when a task is claimable/i);
    expect(text).toMatch(/reclaimed expired leases/i); // event-complete: no work missed while parked
    // Do not spend a model turn while the waiter is still blocking.
    expect(text).toMatch(/exiting background job[\s\S]*re-invokes the main agent/i);
    expect(text).toMatch(/do not exit, return, notify[\s\S]*while the waiter is still blocking/i);
    expect(text).toMatch(/main session blocked or attached/i);
    // Fallback poll loop, only when the CLI is unavailable.
    expect(text).toMatch(/Fallback ONLY if the CLI is unavailable/i);
    expect(text).toMatch(/stateless MCP JSON-RPC endpoint/i);
    expect(text).toMatch(/timeout_s=90/);
    expect(text).toMatch(/600s|10 min/i);
    expect(text).toMatch(/never exit or notify main on an empty result/i);
    expect(text).toMatch(/durable queue/i);
    expect(text).toMatch(/sleep\(idle_interval\)[\s\S]*continue[\s\S]*break/);
    expect(text).toMatch(/lease[\s\S]*verified API-key identity[\s\S]*not the HTTP connection or shared user name/i);
  });

  it("tool descriptions separate harmless availability checks from explicit claims", async () => {
    const check = await coderToolDescription("coder_check_work");
    expect(check).toMatch(/read-only long-poll/i);
    expect(check).toMatch(/90 seconds/);
    expect(check).toMatch(/never claims or reserves/i);
    expect(check).toMatch(/stale positive result is harmless/i);
    const claim = await coderToolDescription("coder_claim_task");
    expect(claim).toMatch(/atomically claim/i);
    expect(claim).toMatch(/null result acquires nothing/i);
    expect(claim).toContain("coder_check_work");
  });

  it("human-only token: does not receive the coder long-poll contract", async () => {
    const text = await instructionsFor("tok-h");
    expect(text).not.toContain("coder_check_work");
    expect(text).not.toContain("coder_claim_task");
  });

  it("admin token: gets both role blocks", async () => {
    const text = await instructionsFor("tok-a");
    expect(text).toContain("human_answer");
    expect(text).toContain("coder_check_work");
    expect(text).toContain("coder_claim_task");
    expect(text).toMatch(/long[- ]poll/i);
    expect(text).toMatch(/available_count[\s\S]*sleep\(idle_interval\)[\s\S]*continue/i);
  });
});
