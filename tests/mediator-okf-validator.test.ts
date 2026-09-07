// The runtime OKF conformance gate: one non-empty free-form type plus a
// kebab-case, non-reserved concept path.
import { describe, expect, it } from "vitest";
import { MemoryStore, validateMemoryDoc, templateFor } from "../src/mediator/memory.js";
import { openTestDb } from "./helpers/db.js";

async function store() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  return { db, memory: new MemoryStore(db) };
}

const doc = (over: Record<string, unknown> = {}) => ({
  path: "decisions/rate-limit.md",
  type: "Decision",
  title: "Rate limiting",
  description: "How ingest is throttled",
  tags: ["ingest"],
  body: "# Context\nBurst traffic overran ingest.\n# Rationale\nToken bucket.\n",
  ...over,
});

describe("validateMemoryDoc", () => {
  it("accepts a well-formed concept", () => {
    expect(validateMemoryDoc(doc())).toEqual({ ok: true });
  });

  it("accepts free-form descriptive types and rejects only blank types", () => {
    for (const type of ["Product", "Insight", "decision", "Customer Research", "Architecture"]) {
      expect(validateMemoryDoc(doc({ type })).ok, type).toBe(true);
    }
    for (const type of ["", "   "]) expect(validateMemoryDoc(doc({ type })).ok, JSON.stringify(type)).toBe(false);
  });

  it("rejects invalid and reserved paths", () => {
    for (const path of ["index.md", "log.md", "tech/index.md", "risks/log.md", "Decisions/x.md", "a b.md", "../x.md", "x.txt"]) {
      expect(validateMemoryDoc(doc({ path })).ok, path).toBe(false);
    }
  });

  it("leaves no-slop and edit-don't-mint discipline to mediator guidance", () => {
    expect(validateMemoryDoc(doc({ body: "plan approved" })).ok).toBe(true);
    expect(validateMemoryDoc(doc({ body: "" })).ok).toBe(true);
  });

  it("templateFor returns the per-type section skeleton", () => {
    expect(templateFor("Decision")).toContain("# Context");
    expect(templateFor("Decision")).toContain("# Consequences");
    expect(templateFor("Risk")).toContain("# Mitigation");
    expect(templateFor("Nonsense")).toBe("");
  });
});

describe("MemoryStore.upsert enforces the validator", () => {
  it("persists free-form types while protecting reserved paths", async () => {
    const { memory } = await store();
    await memory.upsert("p", doc({ path: "tech/product-shape.md", type: "Product" }));
    await memory.upsert("p", doc({ path: "research/operator-feedback.md", type: "Insight" }));
    expect((await memory.get("p", "tech/product-shape.md"))!.type).toBe("Product");
    expect((await memory.get("p", "research/operator-feedback.md"))!.type).toBe("Insight");
    await expect(memory.upsert("p", doc({ path: "index.md", type: "Product" }))).rejects.toThrow(/reserved/);
    await expect(memory.upsert("p", doc({ path: "tech/log.md", type: "Insight" }))).rejects.toThrow(/reserved/);
    await expect(memory.upsert("p", doc({ path: "tech/blank.md", type: " " }))).rejects.toThrow(/non-empty/);
  });
});
