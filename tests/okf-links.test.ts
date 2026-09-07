import { describe, expect, it } from "vitest";
import { parseLinks, resolveLinks, resolveMarkdownLinkTargets } from "../src/mediator/okf-links.js";

type Doc = { path: string; title: string; body: string };

const docs: Doc[] = [
  {
    path: "decisions/rate-limit.md",
    title: "Rate limiting",
    body: "We chose a token bucket. See [[Ingest pipeline]] and [dedup](learnings/dedup.md).",
  },
  {
    path: "ingest/pipeline.md",
    title: "Ingest pipeline",
    body: "The pipeline feeds the queue. Related: [[Rate limiting]].",
  },
  {
    path: "learnings/dedup.md",
    title: "Dedup",
    body: "Duplicate submissions merged. No outbound links here.",
  },
];

describe("parseLinks", () => {
  it("extracts [[wikilink]] targets and markdown .md hrefs", () => {
    const links = parseLinks(docs[0].body);
    expect(links.wikilinks).toEqual(["Ingest pipeline"]);
    expect(links.hrefs).toEqual(["learnings/dedup.md"]);
  });

  it("returns empty arrays for a body with no links", () => {
    expect(parseLinks(docs[2].body)).toEqual({ wikilinks: [], hrefs: [] });
  });

  it("parses standard angle-bracket destinations and optional Markdown titles", () => {
    expect(parseLinks(
      `[Angle](<../core-assets.md#routing> "Routing map")\n` +
      `[Double](peer.md "Peer title") [Single](other.md 'Other title') [Paren](last.md (Last title))`,
    )).toEqual({
      wikilinks: [],
      hrefs: ["<../core-assets.md#routing>", "peer.md", "other.md", "last.md"],
    });
  });

  it("ignores four-space and tab-indented code examples", () => {
    expect(parseLinks(
      `    [Example](target.md)\n\t[[Target]]\n\n[Live](live.md) and [[Live concept]]`,
    )).toEqual({ wikilinks: ["Live concept"], hrefs: ["live.md"] });
  });
});

describe("resolveLinks", () => {
  it("maps same-directory, parent, and bundle-root href bytes to canonical targets", () => {
    const linked: Doc[] = [
      {
        path: "decisions/retry.md",
        title: "Retry",
        body: "[Peer](peer.md) [Core](<../core-assets.md#routing> \"Routing\") [Architecture](/tech/architecture.md)",
      },
      { path: "decisions/peer.md", title: "Peer", body: "" },
      { path: "core-assets.md", title: "Core", body: "" },
      { path: "tech/architecture.md", title: "Architecture", body: "" },
    ];

    expect(resolveMarkdownLinkTargets(linked, "decisions/retry.md")).toEqual([
      { href: "peer.md", path: "decisions/peer.md" },
      { href: "../core-assets.md#routing", path: "core-assets.md" },
      { href: "/tech/architecture.md", path: "tech/architecture.md" },
    ]);
  });

  it("resolves outbound wikilinks (by title) and hrefs (by path) to concepts", () => {
    const { links } = resolveLinks(docs, "decisions/rate-limit.md");
    expect(links).toEqual([
      { path: "ingest/pipeline.md", title: "Ingest pipeline" },
      { path: "learnings/dedup.md", title: "Dedup" },
    ]);
  });

  it("lists backlinks: concepts whose body references the target", () => {
    const { backlinks } = resolveLinks(docs, "ingest/pipeline.md");
    expect(backlinks).toEqual([{ path: "decisions/rate-limit.md", title: "Rate limiting" }]);
  });

  it("never links a concept to itself and dedupes", () => {
    const withSelf: Doc[] = [
      { path: "a/x.md", title: "X", body: "[[X]] and [self](a/x.md) and [[X]]" },
    ];
    const { links, backlinks } = resolveLinks(withSelf, "a/x.md");
    expect(links).toEqual([]);
    expect(backlinks).toEqual([]);
  });

  it("ignores wikilinks and hrefs that match no concept", () => {
    const { links } = resolveLinks(docs, "learnings/dedup.md");
    expect(links).toEqual([]);
  });

  it("resolves angle-bracket and titled destinations without treating the title as a path", () => {
    const titled: Doc[] = [
      {
        path: "decisions/retry.md",
        title: "Retry",
        body: `[Core](<../core-assets.md#routing> "Routing map") [Peer](peer.md 'Peer')`,
      },
      { path: "core-assets.md", title: "Core", body: "" },
      { path: "decisions/peer.md", title: "Peer", body: "" },
    ];
    expect(resolveLinks(titled, "decisions/retry.md").links.map((link) => link.path)).toEqual([
      "core-assets.md",
      "decisions/peer.md",
    ]);
  });
});
