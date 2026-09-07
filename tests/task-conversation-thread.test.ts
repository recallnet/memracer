import { describe, expect, it } from "vitest";
import { preferTaskConversationThread } from "../src/dashboard/web/lib/task-conversation.js";

describe("preferTaskConversationThread", () => {
  it("prefers a task-linked groom/review session over an empty submission root", () => {
    // API returns newest-first; submission root may still be present.
    const threads = [
      { id: 1961, kind: "submission" },
      { id: 2100, kind: "groom" },
      { id: 2101, kind: "review" },
    ];
    // Newest-first: review is first non-submission if we pass that order.
    expect(preferTaskConversationThread(
      [{ id: 2101, kind: "review" }, { id: 2100, kind: "groom" }, { id: 1961, kind: "submission" }],
      1961,
    )).toBe(2101);
    // Even if submission is listed first, skip it when linked work exists.
    expect(preferTaskConversationThread(threads, 1961)).toBe(2100);
  });

  it("falls back to the submission root when no linked threads exist", () => {
    expect(preferTaskConversationThread([{ id: 1961, kind: "submission" }], 1961)).toBe(1961);
    expect(preferTaskConversationThread([], 1961)).toBe(1961);
    expect(preferTaskConversationThread([], null)).toBeNull();
  });
});
