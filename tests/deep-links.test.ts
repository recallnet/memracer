// tests/deep-links.test.ts
// Deep links: the mediator's discuss/answer replies carry a server-minted,
// post-validated `references` array. URLs are derived from ids the model
// already cites inline and validated against the live context pack — the
// model never authors URLs. Unset MEMRACER_PUBLIC_URL degrades to no links.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Db } from "../src/db.js";
import { openDb } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorContext, DiscussInput, DiscussResult } from "../src/mediator/driver.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { refUrl, citableRefs, mintReferences, sanitizeReferenceTokens } from "../src/mediator/pipelines.js";
import { referenceSchema } from "../src/mediator/schemas.js";
import { discussAndWait, submitAndWait } from "./helpers/async-human.js";

describe("mintReferences / refUrl (unit)", () => {
  const base = "https://memracer.example.com";
  const ctx = {
    projectId: "p one",
    queue: [{ id: 7 }, { id: 12 }],
    decisions: [{ id: 3, task_id: 7 }],
    completed: [{ id: 20 }],
    activity: [{ task_id: 31 }],
  } as unknown as MediatorContext;

  it("mints <base>/dashboard?<type>=<id> for each variant", () => {
    expect(refUrl(base, "task", 7)).toBe("https://memracer.example.com/dashboard?task=7");
    expect(refUrl(base, "thread", 9)).toBe("https://memracer.example.com/dashboard?thread=9");
    expect(refUrl(base, "decision", 3)).toBe("https://memracer.example.com/dashboard?decision=3");
  });

  it("strips a trailing slash on the base", () => {
    expect(refUrl("https://x.io/", "task", 1)).toBe("https://x.io/dashboard?task=1");
  });

  it("carries the project scope on internal links while keeping direct callers compatible", () => {
    expect(refUrl(base, "task", 7, undefined, "p one")).toBe(
      "https://memracer.example.com/dashboard?project=p+one&task=7",
    );
    expect(refUrl(base, "decision", 3, 7, "p one")).toBe(
      "https://memracer.example.com/dashboard?project=p+one&task=7#decision-3",
    );
  });

  it("splits the citable universe into task vs decision id sets", () => {
    const refs = citableRefs(ctx);
    expect([...refs.tasks].sort((a, b) => a - b)).toEqual([7, 12, 20, 31]);
    expect([...refs.decisions]).toEqual([3]);
  });

  it("mints references for cited task and decision ids", () => {
    const out = mintReferences(base, "Fixed in #7 per DEC-3; see task:12 too.", citableRefs(ctx));
    expect(out).toEqual([
      { type: "task", id: 7, url: "https://memracer.example.com/dashboard?project=p+one&task=7", label: "task #7" },
      { type: "decision", id: 3, url: "https://memracer.example.com/dashboard?project=p+one&task=7#decision-3", label: "DEC-3" },
      { type: "task", id: 12, url: "https://memracer.example.com/dashboard?project=p+one&task=12", label: "task #12" },
    ]);
    for (const r of out) expect(referenceSchema.parse(r)).toEqual(r);
  });

  it("drops fabricated ids not backed by the context pack", () => {
    const out = mintReferences(base, "See #999 and DEC-888 — invented.", citableRefs(ctx));
    expect(out).toEqual([]);
  });

  it("does not cite a decision without an owning task", () => {
    const refs = citableRefs({ ...ctx, decisions: [{ id: 44, task_id: null }] } as MediatorContext);
    expect(refs.decisions.has(44)).toBe(false);
    expect(mintReferences(base, "DEC-44", refs)).toEqual([]);
    expect(sanitizeReferenceTokens("DEC-44", refs)).toBe("DEC-?");
  });

  it("dedupes repeated citations of the same entity", () => {
    const out = mintReferences(base, "#7 again #7 and task:7", citableRefs(ctx));
    expect(out).toEqual([
      { type: "task", id: 7, url: "https://memracer.example.com/dashboard?project=p+one&task=7", label: "task #7" },
    ]);
  });

  it("degrades to no references when the base is unset", () => {
    expect(mintReferences(undefined, "#7 and DEC-3", citableRefs(ctx))).toEqual([]);
    expect(mintReferences("", "#7 and DEC-3", citableRefs(ctx))).toEqual([]);
  });
});

// A driver whose discuss reply cites whatever task/decision ids exist in the
// live context — so the reference minting is exercised against real records.
function citingDriver(): FakeDriver {
  const base = new FakeDriver();
  const discuss = async (ctx: MediatorContext, _input: DiscussInput): Promise<DiscussResult> => {
    const t = ctx.queue[0]?.id;
    const d = ctx.decisions[0]?.id;
    return { reply: `See task #${t} and DEC-${d}; also #4242 (invented).`, actions: [], rationale: "citing" };
  };
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, { discuss });
}

describe("deep links over MCP (integration)", () => {
  let httpServer: Server;
  let baseUrl: string;
  let worker: MediatorWorker;
  let dbRef: Db;
  const tokens: Record<string, string> = {};

  async function boot(publicUrl?: string): Promise<void> {
    dbRef = openDb(":memory:");
    await betterAuthReady(dbRef);
    await dbRef.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
    tokens["tok-h"] = (await seedMember(dbRef, { name: "dana", projectId: "demo", role: "human" })).token;
    const made = createApp(dbRef, {
      driverFor: () => citingDriver(),
      workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
      publicUrl,
    });
    worker = made.worker;
    await new Promise<void>((resolve) => {
      httpServer = made.app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
  }

  afterEach(async () => {
    worker.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: "test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${tokens[token] ?? token}` } },
    });
    await client.connect(transport);
    return client;
  }

  function parse(result: { content?: unknown }) {
    const content = result.content as { type: string; text: string }[];
    return JSON.parse(content[0].text);
  }

  it("human_discuss carries shareable references for cited task and decision, drops the invented id", async () => {
    await boot("https://memracer.example.com");
    const dana = await connect("tok-h");
    const submitted = await submitAndWait(dana, { title: "Rate limit ingest", body: "add limiter", evidence: [] });
    const taskId = submitted.task.id;
    const discussed = await discussAndWait(dana, { message: "what's the status of ingest?" });
    expect(discussed.references).toContainEqual({
      type: "task",
      id: taskId,
      url: `https://memracer.example.com/dashboard?project=demo&task=${taskId}`,
      label: `task #${taskId}`,
    });
    // A decision (DEC-<n>) was logged by the accept groom and is cited + minted.
    expect(discussed.references.some((r: { type: string }) => r.type === "decision")).toBe(true);
    // The invented #4242 is never backed by a record — it must not appear.
    expect(discussed.references.some((r: { id: number }) => r.id === 4242)).toBe(false);
    await dana.close();
  });

  it("degrades to an empty references array when MEMRACER_PUBLIC_URL is unset", async () => {
    await boot(undefined);
    const dana = await connect("tok-h");
    await submitAndWait(dana, { title: "Rate limit ingest", body: "add limiter", evidence: [] });
    const discussed = await discussAndWait(dana, { message: "status?" });
    expect(discussed.references).toEqual([]);
    await dana.close();
  });
});
