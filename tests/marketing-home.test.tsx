import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketingHome } from "../src/dashboard/web/components/marketing-home.js";

describe("MarketingHome", () => {
  it("renders narrative Product section with fixed-frame shots (not an 8-tile dump)", () => {
    const html = renderToStaticMarkup(<MarketingHome />);

    expect(html).toContain("The factory floor, live.");
    expect(html).toContain("One floor for the whole fleet");
    expect(html).toContain("Every decision, as it happens");
    expect(html).toContain("Spend you can read");
    expect(html).toContain("Human MCP");
    expect(html).toContain("Coder MCP");
    expect(html).toContain("How you work");
    expect(html).toContain("marketing-product-featured");
    expect(html).toContain("marketing-product-secondary");
    expect(html).toContain("marketing-product-mcp-band");
    // Premium layout: featured is not a dump gallery
    expect(html).not.toContain("marketing-product-gallery");

    // New fixed-frame assets only
    expect(html).toContain("/dashboard/marketing/shots/product-ops-1440x900.png");
    expect(html).toContain("/dashboard/marketing/shots/product-timeline-1440x900.png");
    expect(html).toContain("/dashboard/marketing/shots/product-analytics-1440x900.png");
    expect(html).toContain("/dashboard/marketing/shots/mcp-human-1440x900.png");
    expect(html).toContain("/dashboard/marketing/shots/mcp-coder-1440x900.png");
    expect(html).toContain('width="1440"');
    expect(html).toContain('height="900"');

    // Cap: exactly 5 product/MCP images (featured + 2 secondary + 2 MCP)
    const shotImgs = html.match(/\/dashboard\/marketing\/shots\/[^"]+\.png/g) ?? [];
    expect(shotImgs.length).toBe(5);

    // Old dump filenames must be gone
    expect(html).not.toContain("product-home-ops-dark-1440");
    expect(html).not.toContain("product-queue-states");
    expect(html).not.toContain("product-knowledge");
    expect(html).not.toContain("product-home-ops-dark-390");
    expect(html).not.toContain("mcp-claude-code");

    // Hero figure: a mini of the real Operations UI, not an abstract diagram
    expect(html).toContain("marketing-figure");
    expect(html).toContain("PR ✓ MERGED");
    expect(html).toContain("Describe what you want.");
    expect(html).toContain("Get started");
    expect(html).toContain('href="/signin"');
    expect(html).toContain('id="signup"');
    expect(html).not.toContain("Voyeurism");
    // Public paid signup, not a waitlist
    expect(html).not.toContain("Join the waitlist");
    expect(html).toContain("never meter");
    expect(html).not.toContain("we meter it");
    // No invite-only lander deep link to dashboard shell
    expect(html).not.toMatch(/href="\/dashboard"/);

    // Meet Frigg section between how and product
    expect(html).toContain('id="frigg"');
    expect(html).toContain('href="#frigg"');
    expect(html).toContain("Meet Frigg");
    expect(html).toContain('id="agents"');
    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex");
    expect(html).toContain("Antigravity");
    expect(html).toContain("OpenCode");
    expect(html).toContain("Forge");
    expect(html).toContain("Goose");
    // Harnesses render as real icons, each linking out to the harness
    expect(html).toContain("/dashboard/marketing/logos/");
    expect(html).toContain('href="https://claude.com/claude-code"');
    expect(html).toContain('href="https://forgecode.dev"');
    expect(html).toContain("marketing-agent-name");

    expect(html).toContain("The mediator who runs the room.");
    expect(html).toContain("Who");
    expect(html).toContain("What she does");
    expect(html).toContain("Why she matters");
    expect(html).toContain("How you work with her");
    const howIdx = html.indexOf('id="how"');
    const friggIdx = html.indexOf('id="frigg"');
    const productIdx = html.indexOf('id="product"');
    expect(howIdx).toBeGreaterThan(-1);
    expect(friggIdx).toBeGreaterThan(howIdx);
    expect(productIdx).toBeGreaterThan(friggIdx);

    // BYOK-only lander (no Metered product) + soft-delete privacy
    expect(html).toContain("BYOK");
    expect(html).not.toContain("Metered");
    expect(html).not.toContain("marketing-billing-toggle");
    expect(html).not.toContain('aria-label="Model billing mode"');
    expect(html).toContain("BYOK — your key, your spend");
    expect(html).toContain("pay your provider directly");
    // No internal retention/backup policy leaking into landing copy
    expect(html).not.toContain("archive for 30 days");
    expect(html).not.toContain("backups expire");

    // BYO coders band + FAQ trust link (onboarding #563)
    expect(html).toContain("Bring your own coding cloud");
    expect(html).toContain('id="byo"');
    expect(html).toContain("/faq#trust");
    expect(html).toContain("/faq#agents");
  });

  it("marketing.css resolves font sizes and uses white on live fills", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const css = await readFile(resolve(process.cwd(), "src/dashboard/web/styles/marketing.css"), "utf8");
    const theme = await readFile(resolve(process.cwd(), "src/dashboard/web/styles/theme.css"), "utf8");
    expect(css).not.toMatch(/var\(--fs-[0-8]\)/);
    expect(theme).toMatch(/--fs-12:/);
    // Brand CTAs: dark text on the light --accent fill (blue is signal, on hover only)
    expect(css).toMatch(/\.marketing-btn-primary\s*\{[^}]*color:\s*#1d1f2b/s);
    expect(css).toMatch(/\.marketing-nav-cta\s*\{[^}]*color:\s*#1d1f2b/s);
    // Featured badge keeps white text on solid brand blue (AA)
    expect(css).toMatch(/\.marketing-plan-badge\s*\{[^}]*color:\s*#ffffff/s);
  });
});

