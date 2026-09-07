import { describe, it, expect } from "vitest";
import { findContentCollision, type CollisionDb } from "../src/mediator/merge-safety.js";

function mockDb(rows: Array<{ id: number; title: string; body: string }>): CollisionDb {
  return { prepare: () => ({ all: async <T>() => rows as unknown as T[] }) };
}

describe("findContentCollision — groom content-misattribution guard", () => {
  it("flags proposed content that canonically duplicates a DIFFERENT live task", async () => {
    // The #336 shape: grooming task 336, but the model regurgitated task 334's body.
    const db = mockDb([
      { id: 334, title: "Delete the causal SVG trace", body: "Remove the SVG graph from the session view." },
    ]);
    const hit = await findContentCollision(
      db, "memracer", 336,
      "Delete the causal SVG trace",
      "Remove the SVG graph from the session view.",
    );
    expect(hit).toBe(334);
  });

  it("passes genuinely distinct content (no false positive)", async () => {
    const db = mockDb([
      { id: 334, title: "Delete the causal SVG trace", body: "Remove the SVG graph from the session view." },
    ]);
    const hit = await findContentCollision(
      db, "memracer", 345,
      "Dashboard IA overhaul: Team analytics view",
      "Build the contributor leaderboard and the two Frigg panels.",
    );
    expect(hit).toBeNull();
  });

  it("does not flag when there are no other live tasks", async () => {
    const hit = await findContentCollision(mockDb([]), "memracer", 336, "anything", "some body text");
    expect(hit).toBeNull();
  });
});
