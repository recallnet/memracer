// tests/queue-progress.test.ts
import { describe, expect, it, vi } from "vitest";
import { Queue, DEFAULT_LEASE_TTL_MS, LEASE_RECOVERY_GRACE_MS, MAX_LEASE_TTL_MS } from "../src/queue.js";
import { openTestDb } from "./helpers/db.js";

async function claimed(body = "b", leaseTtlMs = DEFAULT_LEASE_TTL_MS) {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
  const q = new Queue(db);
  const id = await q.submit("demo", "dana", { title: "t", body, evidence: [] });
  await q.claimNext("demo", "cc-7f2", leaseTtlMs);
  return { db, q, id };
}

describe("Queue.progress / complete", () => {
  it("progress renews the lease, sets EXECUTING, and records the note", async () => {
    const { q, id } = await claimed();
    const before = (await q.brief(id)).lease_expires_at!;
    const brief = await q.progress(id, "cc-7f2", "tests written", DEFAULT_LEASE_TTL_MS + 60_000);
    expect(brief.state).toBe("EXECUTING");
    expect(brief.lease_expires_at!).toBeGreaterThan(before);
  });

  it("applies generic lease renewal to a long goal: progress prevents claims, silence permits reclaim", async () => {
    const goalBody = "Goal: all tests pass.\nVerify: pnpm test; PASS means exit 0.\nInvariants: preserve APIs; do not change migrations.";
    const ttl = 1000;
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { q, id } = await claimed(goalBody, ttl);
      const originalExpiry = (await q.brief(id)).lease_expires_at!;

      for (let cycle = 1; cycle <= 3; cycle++) {
        now += 750; // still live under the previous renewal, independent of DB round-trip time
        clock.mockReturnValue(now);
        await q.progress(id, "cc-7f2", `goal cycle ${cycle}`, ttl);
        expect((await q.brief(id)).lease_expires_at).toBe(now + ttl);
        expect(await q.claimNext("demo", "cc-other", ttl)).toBeNull();
      }
      expect(now).toBeGreaterThan(originalExpiry); // renewal kept work live beyond the original TTL

      now += ttl + LEASE_RECOVERY_GRACE_MS + 1; // silence beyond renewal plus grace permits reclaim
      clock.mockReturnValue(now);
      const reclaimed = await q.claimNext("demo", "cc-other", ttl);
      expect(reclaimed).toMatchObject({ id, lease_agent: "cc-other" });
      expect(reclaimed?.attempts).toContainEqual({
        agent: "cc-7f2",
        outcome: "lease_expired",
        notes: "lease expired; task requeued",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("heartbeat renews the persisted bounded duration and grace lets the owner complete", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { db, q, id } = await claimed("b", MAX_LEASE_TTL_MS + 1);
      await q.approvePlan(id, "bounded lease recovery");
      expect((await q.brief(id)).lease_ttl_ms).toBe(MAX_LEASE_TTL_MS);
      now += MAX_LEASE_TTL_MS + 1;
      clock.mockReturnValue(now);
      expect(await q.claimNext("demo", "cc-other", DEFAULT_LEASE_TTL_MS)).toBeNull();
      const [renewed] = await q.renewAgentLeases("cc-7f2");
      expect(renewed).toMatchObject({ id, lease_expires_at: now + MAX_LEASE_TTL_MS });

      now += MAX_LEASE_TTL_MS + 1;
      clock.mockReturnValue(now);
      const done = await q.complete(id, "cc-7f2", "reconciled open PR", "https://github.com/x/y/pull/9");
      expect(done.state).toBe("DONE");
      expect(await db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND outcome='lease_expired'").get(id)).toEqual({ n: 0 });
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects stale-owner completion after the task is reassigned", async () => {
    const { db, q, id } = await claimed();
    await q.approvePlan(id, "ship the change");
    await db.prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?")
      .run(Date.now() - LEASE_RECOVERY_GRACE_MS - 1, id);
    expect((await q.claimNext("demo", "cc-new", DEFAULT_LEASE_TTL_MS))?.id).toBe(id);

    await expect(q.complete(id, "cc-7f2", "stale completion", "https://github.com/x/y/pull/9"))
      .rejects.toThrow(/no live lease/);
    expect(await db.prepare("SELECT state, lease_agent FROM tasks WHERE id=?").get(id)).toEqual({
      state: "CLAIMED",
      lease_agent: "cc-new",
    });
  });

  it("progress persists each note; the brief returns them with agent and timestamp", async () => {
    const { q, id } = await claimed();
    await q.progress(id, "cc-7f2", "tests written", DEFAULT_LEASE_TTL_MS);
    await q.progress(id, "cc-7f2", "impl done", DEFAULT_LEASE_TTL_MS);
    const notes = (await q.brief(id)).notes;
    expect(notes.map((n) => n.note)).toEqual(["tests written", "impl done"]);
    expect(notes[0].agent).toBe("cc-7f2");
    expect(notes[0].created_at).toBeTypeOf("number");
  });

  it("notes survive a requeue and ride the next claim's brief", async () => {
    const { q, id } = await claimed();
    await q.progress(id, "cc-7f2", "halfway through the migration", DEFAULT_LEASE_TTL_MS);
    await q.release(id, "cc-7f2", "out of depth");
    const brief = (await q.claimNext("demo", "cc-9x1", DEFAULT_LEASE_TTL_MS))!;
    expect(brief.id).toBe(id);
    expect(brief.notes.map((n) => n.note)).toEqual(["halfway through the migration"]);
  });

  it("the brief caps notes at the 20 most recent, in chronological order", async () => {
    const { q, id } = await claimed();
    for (let i = 0; i < 25; i++) await q.progress(id, "cc-7f2", `note ${i}`, DEFAULT_LEASE_TTL_MS);
    const notes = (await q.brief(id)).notes;
    expect(notes).toHaveLength(20);
    expect(notes[0].note).toBe("note 5");
    expect(notes[19].note).toBe("note 24");
  });

  it("rejects progress from a non-lease-holder", async () => {
    const { q, id } = await claimed();
    await expect(q.progress(id, "intruder", "hi", DEFAULT_LEASE_TTL_MS)).rejects.toThrow(/lease/);
  });

  it("complete sets DONE, clears the lease, and records the attempt", async () => {
    const { q, id } = await claimed();
    const brief = await q.complete(id, "cc-7f2", "shipped", "https://github.com/x/y/pull/1");
    expect(brief.state).toBe("DONE");
    expect(brief.lease_agent).toBeNull();
    expect(brief.result_summary).toBe("shipped");
    expect(brief.result_pr_url).toBe("https://github.com/x/y/pull/1");
    expect(brief.attempts).toEqual([{ agent: "cc-7f2", outcome: "completed", notes: "shipped" }]);
  });

  it("complete parses the trailing PR number from the URL", async () => {
    const { q, id } = await claimed();
    const brief = await q.complete(id, "cc-7f2", "shipped", "https://github.com/x/y/pull/128");
    expect(brief.result_pr_number).toBe(128);
  });

  it("complete stores a null PR number when the URL has no trailing integer", async () => {
    const { q, id } = await claimed();
    const brief = await q.complete(id, "cc-7f2", "shipped", "https://github.com/x/y/pulls");
    expect(brief.result_pr_url).toBe("https://github.com/x/y/pulls");
    expect(brief.result_pr_number).toBeNull();
  });

});
