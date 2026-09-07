// The seeded core-asset skeleton (#88) and the reciprocal-gap helper.
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/mediator/memory.js";
import { seedSkeleton } from "../src/mediator/okf-seed.js";
import {
  normalizeMarkdownHref,
  reciprocalGaps,
  resolveLinks,
  type LinkableDoc,
} from "../src/mediator/okf-links.js";
import { openTestDb } from "./helpers/db.js";

describe("seedSkeleton", () => {
  it("seeds a minimal, typed, cross-linked skeleton (no index/log)", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const memory = new MemoryStore(db);

    const paths = await seedSkeleton(db, "p");
    expect(paths).toContain("architecture.md");
    expect(paths).toContain("core-assets.md");
    expect(paths).toContain("glossary.md");
    expect(paths).toContain("roadmap.md");
    expect(paths.some((p) => p.startsWith("conventions/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("decisions/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("risks/"))).toBe(true);
    // reserved generated files are never seeded
    expect(paths).not.toContain("index.md");
    expect(paths).not.toContain("log.md");

    // every seeded concept carries one non-empty descriptive type
    const docs = await memory.list("p");
    for (const d of docs) expect(d.type.trim(), d.path).not.toBe("");

    // core-assets.md links out to the assets → the graph has edges from the start
    const core = (await memory.get("p", "core-assets.md"))!;
    expect(core.body).toContain("architecture.md");
    expect(core.body).toContain("glossary.md");
    expect(core.body).toContain("Answered question");
    expect(core.body).toContain("Priority or product/scope change");
    expect(core.body).toContain("Architecture change");
    expect(core.body).toContain("Tail check");

    // and each asset links back to core-assets.md (reciprocal)
    const arch = (await memory.get("p", "architecture.md"))!;
    expect(arch.body).toContain("core-assets.md");
    const convention = (await memory.get("p", "conventions/test-command.md"))!;
    expect(convention.body).toContain("[Core assets](../core-assets.md)");
  });
});

describe("reciprocalGaps", () => {
  it("reports one-directional edges only", () => {
    const docs: LinkableDoc[] = [
      { path: "a.md", title: "A", body: "see [B](b.md) and [C](c.md)" },
      { path: "b.md", title: "B", body: "see [A](a.md)" }, // reciprocates A
      { path: "c.md", title: "C", body: "no links" }, // does NOT reciprocate A
    ];
    expect(reciprocalGaps(docs)).toEqual([{ from: "a.md", to: "c.md" }]);
  });

  it("normalizes same-directory, parent, and bundle-root hrefs without escaping the bundle", () => {
    expect(normalizeMarkdownHref("decisions/api/retry.md", "peer.md")).toBe("decisions/api/peer.md");
    expect(normalizeMarkdownHref("decisions/api/retry.md", "../../architecture.md#flow")).toBe("architecture.md");
    expect(normalizeMarkdownHref("decisions/api/retry.md", "/risks/retry.md?view=full")).toBe("risks/retry.md");
    expect(normalizeMarkdownHref("architecture.md", "../outside.md")).toBeNull();
    expect(normalizeMarkdownHref("decisions/retry.md", "../../../outside.md")).toBeNull();
    expect(normalizeMarkdownHref("decisions/retry.md", "https://example.test/x.md")).toBeNull();
  });

  it("resolves normalized hrefs and reciprocal gaps from each source concept", () => {
    const docs: LinkableDoc[] = [
      { path: "architecture.md", title: "Architecture", body: "[Retry](/decisions/api/retry.md)" },
      { path: "decisions/api/retry.md", title: "Retry", body: "[Peer](peer.md) [Architecture](../../architecture.md)" },
      { path: "decisions/api/peer.md", title: "Peer", body: "[Retry](retry.md)" },
    ];
    expect(resolveLinks(docs, "decisions/api/retry.md").links.map((link) => link.path)).toEqual([
      "architecture.md",
      "decisions/api/peer.md",
    ]);
    expect(resolveLinks(docs, "architecture.md").backlinks.map((link) => link.path)).toEqual([
      "decisions/api/retry.md",
    ]);
    expect(reciprocalGaps(docs)).toEqual([]);
  });

  it("does not treat fenced or inline markdown examples as graph edges", () => {
    const docs: LinkableDoc[] = [
      {
        path: "guide.md",
        title: "Guide",
        body: "`[Inline](target.md)`\n\n```md\n[Fenced](target.md)\n```\n\n[Live](live.md)",
      },
      { path: "target.md", title: "Target", body: "No live relationship." },
      { path: "live.md", title: "Live", body: "[Guide](guide.md)" },
    ];
    expect(resolveLinks(docs, "guide.md").links.map((link) => link.path)).toEqual(["live.md"]);
    expect(reciprocalGaps(docs)).toEqual([]);
  });

  it("the seeded skeleton's core-asset links are reciprocal (no gap to/from core-assets)", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const memory = new MemoryStore(db);
    await seedSkeleton(db, "p");
    const list = await memory.list("p");
    const docs: LinkableDoc[] = [];
    for (const d of list) {
      const full = (await memory.get("p", d.path))!;
      docs.push({ path: full.path, title: full.title, body: full.body });
    }
    // Strict relative resolution sees the complete seeded graph as reciprocal;
    // nested concepts do not rely on the dashboard's legacy root fallback.
    expect(reciprocalGaps(docs)).toEqual([]);
  });

  it("keeps reciprocal validation strict while dashboard resolution alone accepts legacy root bytes", () => {
    const docs: LinkableDoc[] = [
      { path: "core-assets.md", title: "Core assets", body: "[Decision](decisions/retry.md)" },
      { path: "decisions/retry.md", title: "Decision", body: "[Core](core-assets.md)" },
    ];
    expect(reciprocalGaps(docs)).toEqual([{ from: "core-assets.md", to: "decisions/retry.md" }]);
    expect(reciprocalGaps(docs, { allowLegacyRootPaths: true })).toEqual([]);
    expect(resolveLinks(docs, "decisions/retry.md").links.map((link) => link.path)).toEqual(["core-assets.md"]);
  });
});
