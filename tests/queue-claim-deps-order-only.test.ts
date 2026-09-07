/**
 * Dependencies are order hints only — open predecessors never suppress claim.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { Queue } from "../src/queue.js";

let db: Db;
let queue: Queue;

beforeEach(() => {
  db = openDb(":memory:");
  queue = new Queue(db);
});

afterEach(() => {
  // in-memory
});

describe("claim with open dependencies", () => {
  it("claims a dependent while predecessor is still QUEUED", async () => {
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?,?,?)").run("p", "P", "r/p");
    const pred = await queue.submit("p", "ada", { title: "Predecessor", body: "first", evidence: [] });
    const dep = await queue.submit("p", "ada", { title: "Dependent", body: "second", evidence: [] });
    await db.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)").run(dep, pred);

    // Dependent still claimable (may be offered after predecessor in ordering)
    const claimed = await queue.claimNext("p", "coder-1", 60_000);
    expect(claimed).not.toBeNull();
    expect([pred, dep]).toContain(claimed!.id);

    // Second claim gets the other while first remains incomplete
    const claimed2 = await queue.claimNext("p", "coder-2", 60_000);
    expect(claimed2).not.toBeNull();
    expect(new Set([claimed!.id, claimed2!.id])).toEqual(new Set([pred, dep]));
  });
});
