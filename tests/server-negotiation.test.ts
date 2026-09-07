/**
 * Live negotiation wiring (#441): elicitInput advances NegotiationStore,
 * reconnect re-dispatches open negotiations, human_answer records transcript.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { openDb } from "../src/db.js";
import { NegotiationStore } from "../src/negotiation.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { submitAndWait } from "./helpers/async-human.js";
import { DEFAULT_LEASE_TTL_MS } from "../src/queue.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let db: Db;
let tokH: string;
let tokC: string;

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','recallnet/demo-app')").run();
  tokH = (await seedMember(db, { name: "dana", projectId: "demo", role: "human" })).token;
  tokC = (await seedMember(db, { name: "coder-1", projectId: "demo", role: "coder" })).token;
  const made = createApp(db, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 5_000 },
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

function parse(result: { content?: unknown }) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

async function connect(token: string, opts?: { elicitation?: boolean }): Promise<Client> {
  const client = new Client(
    { name: "neg-test", version: "0.0.1" },
    opts?.elicitation ? { capabilities: { elicitation: {} } } : undefined,
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

const clarifySubmit = {
  title: "t",
  body: "CLARIFY: Which region should host it? Recommended: eu-west-1 — it matches the current deployment.",
  project: "demo",
};

describe("negotiation live wiring", () => {
  it("pipeline-opens-negotiation on groom clarify and surfaces negotiation_id", async () => {
    const client = await connect(tokH);
    const result = await submitAndWait(client, clarifySubmit);
    expect(result.grooming.action).toBe("clarify");
    expect(result.grooming.negotiation_id).toMatch(/^neg_/);
    const row = await db
      .prepare("SELECT state, party_role FROM negotiations WHERE id = ?")
      .get<{ state: string; party_role: string }>(result.grooming.negotiation_id);
    expect(row).toEqual({ state: "awaiting_party", party_role: "human" });
    await client.close();
  });

  it("connected party receives elicit, answer advances transcript and re-grooms", async () => {
    const client = await connect(tokH, { elicitation: true });
    const seen: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      seen.push(req.params.message);
      return { action: "accept", content: { answer: "eu-west-1" } };
    });

    const result = await submitAndWait(client, clarifySubmit);
    expect(result.grooming.action).toBe("clarify");
    const negId = result.grooming.negotiation_id as string;

    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));
    await vi.waitFor(async () => {
      const n = await new NegotiationStore(db).get(negId);
      // Answer advances to open; re-groom may then accept and finalize.
      expect(["open", "accepted"]).toContain(n?.state);
      const transcript = JSON.parse(n!.transcript) as Array<{ kind: string; content: string }>;
      expect(transcript.some((e) => e.kind === "answer" && e.content === "eu-west-1")).toBe(true);
    });
    await client.close();
  });

  it("human_answer advances negotiation transcript when offline", async () => {
    const client = await connect(tokH);
    const result = await submitAndWait(client, clarifySubmit);
    const negId = result.grooming.negotiation_id as string;
    const answered = parse(
      await client.callTool({
        name: "human_answer",
        arguments: { question_id: result.grooming.question_id, answer: "us-east-2" },
      }),
    );
    expect(answered.regroomed).toBe(true);
    expect(answered.negotiation_id).toBe(negId);
    await vi.waitFor(async () => {
      const n = await new NegotiationStore(db).get(negId);
      expect(["open", "accepted"]).toContain(n?.state);
      const transcript = JSON.parse(n!.transcript) as Array<{ kind: string; content: string }>;
      expect(transcript.some((e) => e.kind === "answer" && e.content === "us-east-2")).toBe(true);
    });
    await client.close();
  });

  it("reconnect re-dispatches open negotiations via dispatchOpenClarifications", async () => {
    // First connection: open a negotiation without accepting elicit (hold open).
    const first = await connect(tokH, { elicitation: true });
    let releaseFirst!: (value: { action: "decline" }) => void;
    let firstSeen = 0;
    first.setRequestHandler(ElicitRequestSchema, async () => {
      firstSeen += 1;
      return new Promise<{ action: "decline" }>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const result = await submitAndWait(first, clarifySubmit);
    expect(result.grooming.action).toBe("clarify");
    const negId = result.grooming.negotiation_id as string;
    const questionId = result.grooming.question_id as number;
    await vi.waitFor(() => expect(firstSeen).toBe(1));
    expect((await new NegotiationStore(db).get(negId))?.state).toBe("awaiting_party");
    await first.close();

    // Reconnect: StreamableHTTP opens GET for server→client; streamReady re-dispatches.
    const resumed = new Client(
      { name: "neg-test", version: "0.0.1" },
      { capabilities: { elicitation: {} } },
    );
    const seen: string[] = [];
    resumed.setRequestHandler(ElicitRequestSchema, async (req) => {
      seen.push(req.params.message);
      return { action: "accept", content: { answer: "eu-west-1" } };
    });
    await resumed.connect(new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${tokH}` } },
    }));

    // Live re-elicit must fire (no human_answer fallback that masks a broken path).
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
    await vi.waitFor(async () => {
      const n = await new NegotiationStore(db).get(negId);
      expect(["open", "accepted"]).toContain(n?.state);
    });
    // Legacy questions row closed via task+negotiation prompt lookup (questionId:0 path).
    await vi.waitFor(async () => {
      expect(
        await db.prepare("SELECT status, answer FROM questions WHERE id=?").get(questionId),
      ).toEqual({ status: "answered", answer: "eu-west-1" });
    });
    releaseFirst({ action: "decline" });
    await resumed.close();
  });

  it("reconnect closes questions via durable question_id even when clarify text was edited", async () => {
    const first = await connect(tokH, { elicitation: true });
    let releaseFirst!: (value: { action: "decline" }) => void;
    let firstSeen = 0;
    first.setRequestHandler(ElicitRequestSchema, async () => {
      firstSeen += 1;
      return new Promise<{ action: "decline" }>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const result = await submitAndWait(first, clarifySubmit);
    expect(result.grooming.action).toBe("clarify");
    const negId = result.grooming.negotiation_id as string;
    const questionId = result.grooming.question_id as number;
    await vi.waitFor(() => expect(firstSeen).toBe(1));

    // Durable link must already be stored on the negotiation.
    expect(
      await db.prepare("SELECT question_id FROM negotiations WHERE id=?").get(negId),
    ).toEqual({ question_id: questionId });

    // Editing both the ledger text and current_prompt breaks text match;
    // reconnect must still close via question_id.
    await db
      .prepare("UPDATE questions SET question=? WHERE id=?")
      .run("EDITED clarify text that no longer matches the original prompt?", questionId);
    await db
      .prepare("UPDATE negotiations SET current_prompt=? WHERE id=?")
      .run("DIFFERENT prompt text after the clarify was rephrased", negId);
    await first.close();

    const resumed = new Client(
      { name: "neg-test", version: "0.0.1" },
      { capabilities: { elicitation: {} } },
    );
    const seen: string[] = [];
    resumed.setRequestHandler(ElicitRequestSchema, async (req) => {
      seen.push(req.params.message);
      return { action: "accept", content: { answer: "eu-west-1" } };
    });
    await resumed.connect(new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${tokH}` } },
    }));

    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
    await vi.waitFor(async () => {
      expect(
        await db.prepare("SELECT status, answer FROM questions WHERE id=?").get(questionId),
      ).toEqual({ status: "answered", answer: "eu-west-1" });
    });
    releaseFirst({ action: "decline" });
    await resumed.close();
  });

  it("coder_answer advances coder negotiation and re-reviews", async () => {
    const human = await connect(tokH);
    // Accept a normal task first.
    const submitted = parse(await human.callTool({
      name: "human_submit",
      arguments: {
        project: "demo",
        title: "Ship feature",
        body: "FEATURE: implement the widget with tests",
        evidence: [{ kind: "code", path: "src/widget.ts" }],
      },
    }));
    await worker.waitForJob(submitted.job_id, 3_000);
    await human.close();

    const coder = await connect(tokC);
    const claim = parse(await coder.callTool({
      name: "coder_claim_task",
      arguments: { project: "demo", lease_duration_ms: DEFAULT_LEASE_TTL_MS },
    }));
    expect(claim?.id).toEqual(expect.any(Number));
    const reviewRaw = await coder.callTool({
      name: "coder_propose_plan",
      arguments: {
        task_id: claim.id,
        plan: "CLARIFY: Which widget library — material or custom?",
      },
    });
    const reviewText = (reviewRaw.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(reviewText).not.toMatch(/^mediator job/i);
    const review = JSON.parse(reviewText);
    expect(review.verdict).toBe("clarify");
    expect(review.negotiation_id).toMatch(/^neg_/);
    const negId = review.negotiation_id as string;
    expect((await new NegotiationStore(db).get(negId))?.state).toBe("awaiting_party");
    expect((await db.prepare("SELECT plan FROM tasks WHERE id = ?").get<{ plan: string }>(claim.id))?.plan).toContain("CLARIFY:");

    // Second propose with a real plan after answering — coder_answer re-reviews
    // the stored clarify plan (still CLARIFY:*) so first re-review may clarify again;
    // record transcript via answer, then propose a clean plan.
    const answeredRaw = await coder.callTool({
      name: "coder_answer",
      arguments: { task_id: claim.id, answer: "custom components" },
    });
    const answeredText = (answeredRaw.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(answeredText).not.toMatch(/^mediator job failed/i);
    const answered = JSON.parse(answeredText);
    expect(answered.rereviewed).toBe(true);
    expect(answered.negotiation_id).toBe(negId);
    const n = await new NegotiationStore(db).get(negId);
    const transcript = JSON.parse(n!.transcript) as Array<{ kind: string; content: string }>;
    expect(transcript.some((e) => e.kind === "answer" && e.content === "custom components")).toBe(true);
    await coder.close();
  });
});
