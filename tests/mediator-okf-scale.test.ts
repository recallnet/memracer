// SCALE (#88): model the prompt's grep-first/edit-don't-mint discipline over a
// stream of decisions. Concept growth stays bounded without inventing an OKF
// runtime rule that rejects similar concepts.
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/mediator/memory.js";
import { MemoryTools } from "../src/mediator/memory-tools.js";
import { openTestDb } from "./helpers/db.js";

describe("OKF scale — bounded concept growth", () => {
  it("a stream of N per-task decisions collapses into ONE edited-in-place concept", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const memory = new MemoryStore(db);
    const tools = new MemoryTools(db).bind("p");

    const N = 25;
    await memory.upsert("p", {
      path: "decisions/dependency-order.md",
      type: "Decision",
      title: "Dependency ordering",
      description: "how task dependencies gate claiming",
      tags: ["dependencies", "ordering"],
      body: "# Context\nInitial dependency ordering.\n",
    });
    for (let i = 0; i < N; i++) {
      const grep = (await tools.dispatch("okf_grep", { query: "dependency ordering" })) as {
        matches: { path: string }[];
      };
      expect(grep.matches).toHaveLength(1);
      const update = (await tools.dispatch("okf_update", {
        path: grep.matches[0].path,
        body: `# Context\nTask ${i} touched dependency ordering.\n# Rationale\nOrder-only, no claim gate.\n# Status\nCurrent.\n# Consequences\n# Citations\ntask ${i}\n`,
      })) as { error?: string; ok?: boolean };
      expect(update.ok, update.error).toBe(true);
    }

    const concepts = await memory.list("p");
    expect(concepts).toHaveLength(1); // bounded — ONE concept, not N
    const doc = (await memory.get("p", concepts[0].path))!;
    expect(doc.title).toBe("Dependency ordering");
    expect(doc.body).toContain(`task ${N - 1}`); // latest-input-wins edit
  });
});
