import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketingFaq } from "../src/dashboard/web/components/marketing-faq.js";
import { FAQ_SECTIONS } from "../src/dashboard/public/onboarding-copy.js";

describe("MarketingFaq", () => {
  it("renders all seven FAQ section anchors from the shared copy module", () => {
    const html = renderToStaticMarkup(<MarketingFaq />);
    expect(html).toContain("FAQ");
    for (const section of FAQ_SECTIONS) {
      expect(html).toContain(`id="${section.id}"`);
      expect(html).toContain(section.title);
      expect(html).toContain(`href="#${section.id}"`);
    }
    expect(html).toContain("href=\"/\"");
  });
});
