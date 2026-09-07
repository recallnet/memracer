import { describe, expect, it } from "vitest";
import {
  AIR_GAP_SUMMARY,
  BYO_BAND_TITLE,
  FAQ_SECTIONS,
  GET_STARTED_TITLE,
  HOW_THIS_WORKS_HREF,
  SEAT_EMPTY_BANNER,
  SEAT_PARTIAL_BANNER,
  TOKEN_SCOPE_NOTE,
  TRUST_SUMMARY,
} from "../src/dashboard/public/onboarding-copy.js";

describe("onboarding-copy", () => {
  it("exports the seven FAQ sections with stable anchors", () => {
    expect(FAQ_SECTIONS.map((s) => s.id)).toEqual([
      "what",
      "roles",
      "setup",
      "trust",
      "agents",
      "merge",
      "billing",
    ]);
    for (const section of FAQ_SECTIONS) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.body.length).toBeGreaterThan(20);
    }
  });

  it("keeps air-gap and trust strings non-empty and shared", () => {
    expect(AIR_GAP_SUMMARY).toMatch(/air-gap|two machines|container/i);
    expect(TRUST_SUMMARY).toMatch(/host isolation|human|coder/i);
    expect(TOKEN_SCOPE_NOTE).toMatch(/project|role|password/i);
    expect(GET_STARTED_TITLE).toMatch(/Get started/i);
    expect(SEAT_EMPTY_BANNER).toMatch(/human|coder/i);
    expect(SEAT_PARTIAL_BANNER).toMatch(/human|coder/i);
    expect(BYO_BAND_TITLE).toMatch(/Bring your own/i);
    expect(HOW_THIS_WORKS_HREF).toBe("/faq");
  });
});
