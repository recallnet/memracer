import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KnowledgeBody } from "../src/dashboard/web/components/knowledge-body.js";

function render(body: string) {
  return renderToStaticMarkup(createElement(KnowledgeBody, {
    body,
    linkTargets: [
      { href: "peer.md", path: "decisions/peer.md" },
      { href: "../core-assets.md#routing", path: "core-assets.md" },
      { href: "/tech/architecture.md", path: "tech/architecture.md" },
    ],
    onConcept: () => undefined,
  }));
}

describe("Knowledge concept markdown", () => {
  it("renders GFM structure and canonical concept actions", () => {
    const markup = render([
      "# Runbook",
      "",
      "- Read [Peer](peer.md)",
      "- Read [Core](../core-assets.md#routing)",
      "- Read [Architecture](/tech/architecture.md)",
      "- Run `pnpm test`",
      "",
      "| check | state |",
      "| --- | --- |",
      "| build | green |",
      "",
      "```sh",
      "pnpm test",
      "```",
    ].join("\n"));

    expect(markup).toContain("<h1>Runbook</h1>");
    expect(markup).toContain("<ul>");
    expect(markup).toContain("<table>");
    expect(markup).toContain("<pre><code class=\"language-sh\"");
    expect(markup).toContain("data-concept-path=\"decisions/peer.md\">Peer</button>");
    expect(markup).toContain("data-concept-path=\"core-assets.md\">Core</button>");
    expect(markup).toContain("data-concept-path=\"tech/architecture.md\">Architecture</button>");
  });

  it("leaves broken concepts inert and hardens external links", () => {
    const markup = render("See [Missing](missing.md#section) and [release notes](https://example.com/release).");
    expect(markup).toContain("See Missing and ");
    expect(markup).not.toContain("href=\"missing.md#section\"");
    expect(markup).not.toContain(">Missing</button>");
    expect(markup).toContain("href=\"https://example.com/release\"");
    expect(markup).toContain("target=\"_blank\"");
    expect(markup).toContain("rel=\"noopener noreferrer\"");
  });

  it("escapes raw HTML rather than injecting it", () => {
    const markup = render("<img src=x onerror=alert(1)> **safe**");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).toContain("<strong>safe</strong>");
  });

  it("hides malformed frontmatter and restores escaped Markdown newlines", () => {
    const markup = render("---\\ntitle: Leaked metadata\\ntags: [knowledge]\\n---\\n# Repaired concept\\n\\nThe **semantic body** remains.");

    expect(markup).not.toContain("Leaked metadata");
    expect(markup).not.toContain("tags: [knowledge]");
    expect(markup).not.toContain("---");
    expect(markup).toContain("<h1>Repaired concept</h1>");
    expect(markup).toContain("The <strong>semantic body</strong> remains.");
  });
});
