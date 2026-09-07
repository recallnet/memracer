import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorContext, ProjectKnowledgeRefreshInput, Submission } from "../src/mediator/driver.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { QUESTION_LEDGER_PATH } from "../src/mediator/question-ledger.js";
import { MemoryStore } from "../src/mediator/memory.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { submitAndWait } from "./helpers/async-human.js";

class LedgerAwareDriver extends FakeDriver {
  learned = "";

  override async refreshProjectKnowledge(ctx: MediatorContext, input: ProjectKnowledgeRefreshInput) {
    if (input.answer) {
      const domain = input.answer.domain ?? "priorities-roadmap";
      await ctx.tools?.dispatch("okf_grep", { query: domain });
      await ctx.tools?.dispatch("okf_write", {
        path: `context/${domain}.md`,
        type: "Project context",
        title: domain,
        description: "Human-confirmed project context",
        tags: [`domain:${domain}`],
        body: `# Context\n\n${input.answer.answer}`,
      });
      return { checked_domains: [domain], questions: [], rationale: "curated human answer" };
    }
    const selected = input.candidates.slice(0, 3);
    return {
      checked_domains: selected.map((candidate) => candidate.domain),
      questions: selected.map((candidate) => ({
        domain: candidate.domain,
        trigger: candidate.triggers[0],
        question: `What durable context should the mediator know about ${candidate.label.toLowerCase()}?`,
      })),
      rationale: "asked a bounded adaptive batch",
    };
  }

  override async groom(ctx: MediatorContext, submission: Submission) {
    const read = (await ctx.tools?.dispatch("okf_read", { path: QUESTION_LEDGER_PATH })) as
      | { content?: string }
      | undefined;
    this.learned = read?.content ?? "";
    const result = await super.groom(ctx, submission);
    if (result.action === "accept") {
      return {
        ...result,
        rationale: `used project memory: ${this.learned.includes("priorities and roadmap")}`,
        project_questions: ["Which onboarding metric should define success?"],
      };
    }
    return result;
  }
}

let db: Db;
let server: Server;
let worker: MediatorWorker;
let baseUrl: string;
let humanToken: string;
let otherToken: string;
let driver: LedgerAwareDriver;

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p1','One'),('p2','Two')").run();
  humanToken = (await seedMember(db, { name: "Dana", projectId: "p1", role: "human" })).token;
  otherToken = (await seedMember(db, { name: "Rui", projectId: "p2", role: "human" })).token;
  driver = new LedgerAwareDriver();
  const made = createApp(db, {
    driverFor: () => driver,
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
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
  await db.close();
});

async function connect(token: string): Promise<Client> {
  const client = new Client(
    { name: "question-ledger-test", version: "0.0.1" },
    { capabilities: { elicitation: {} } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

function parse(result: { content?: unknown }) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

describe("project question ledger over MCP", () => {
  it("adaptively asks, curates answers, recalls, and adds project unknowns without elicitation", async () => {
    const human = await connect(humanToken);
    let elicited = 0;
    human.setRequestHandler(ElicitRequestSchema, async () => {
      elicited++;
      return { action: "decline" as const };
    });

    const initial = parse(await human.callTool({ name: "human_status", arguments: {} }));
    expect(initial.projects.p1.tasks).toEqual([]);
    const refresh = await worker.findLatestJob("p1", "refresh", { mode: "refresh" });
    await worker.waitForJob(refresh!.id, 2_000);
    const prompted = initial.open_questions.length > 0
      ? initial
      : parse(await human.callTool({ name: "human_status", arguments: {} }));
    expect(prompted.open_questions).toHaveLength(3);
    expect(prompted.open_questions.every((q: { task_id: number | null }) => q.task_id === null)).toBe(true);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id='p1' AND kind='refresh'").get()).toEqual({ n: 1 });

    const [product, builtFrom, users] = prompted.open_questions;
    const first = parse(
      await human.callTool({
        name: "human_answer",
        arguments: { question_id: product.id, answer: "A developer collaboration service" },
      }),
    );
    await worker.waitForJob(first.job_id, 2_000);
    const second = parse(
      await human.callTool({
        name: "human_answer",
        arguments: { question_id: users.id, answer: "Developers and technical leads" },
      }),
    );
    await worker.waitForJob(second.job_id, 2_000);
    expect(first).toMatchObject({ answered: product.id, project: "p1", regroomed: false });
    expect(second).toMatchObject({ answered: users.id, project: "p1", regroomed: false });
    expect(elicited).toBe(0);
    expect((await new MemoryStore(db).get("p1", "context/product-bounds.md"))?.body)
      .toContain("A developer collaboration service");
    expect(await db.prepare(
      "SELECT last_refreshed_at IS NOT NULL AS fresh FROM project_context_domains WHERE project_id='p1' AND domain='product-bounds'",
    ).get()).toEqual({ fresh: 1 });

    const ledger = await new MemoryStore(db).get("p1", QUESTION_LEDGER_PATH);
    expect(ledger?.body).toContain(`[open] Q${builtFrom.id}`);
    expect(ledger?.body).toContain("priorities and roadmap");
    expect(ledger?.body).not.toContain(`[answered] Q${product.id}`);
    expect(ledger?.body).not.toContain("A developer collaboration service");
    expect(ledger?.body).not.toContain(`[answered] Q${users.id}`);
    expect(ledger?.body).not.toContain("Developers and technical leads");

    const submitted = await submitAndWait(human, {
      project: "p1", title: "Improve developer onboarding", body: "tighten onboarding", evidence: [],
    });
    expect(submitted.grooming).toMatchObject({ action: "accept" });
    expect(driver.learned).toContain("priorities and roadmap");
    expect(driver.learned).not.toContain("Developers and technical leads");
    expect(submitted.task.grooming_rationale).toContain("used project memory: true");
    const after = parse(await human.callTool({ name: "human_status", arguments: {} }));
    expect(after.open_questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_id: null,
          question: "Which onboarding metric should define success?",
        }),
      ]),
    );
    const groomQuestion = after.open_questions.find(
      (question: { question: string }) => question.question === "Which onboarding metric should define success?",
    );
    const groomAnswer = parse(await human.callTool({
      name: "human_answer",
      arguments: { question_id: groomQuestion.id, answer: "Activation within the first successful project." },
    }));
    await worker.waitForJob(groomAnswer.job_id, 2_000);
    expect((await new MemoryStore(db).get("p1", "context/priorities-roadmap.md"))?.body)
      .toContain("Activation within the first successful project.");
    expect(await db.prepare("SELECT curated_at IS NOT NULL AS curated FROM questions WHERE id=?").get(groomQuestion.id))
      .toEqual({ curated: 1 });
    expect(elicited).toBe(0);

    const other = await connect(otherToken);
    parse(await other.callTool({ name: "human_status", arguments: {} }));
    const otherRefresh = await worker.findLatestJob("p2", "refresh", { mode: "refresh" });
    await worker.waitForJob(otherRefresh!.id, 2_000);
    const otherStatus = parse(await other.callTool({ name: "human_status", arguments: {} }));
    const forbidden = await human.callTool({
      name: "human_answer",
      arguments: { question_id: otherStatus.open_questions[0].id, answer: "cross tenant" },
    });
    expect(forbidden.isError).toBe(true);
    await other.close();
    await human.close();
  });
});
