import { describe, expect, it } from "vitest";
import {
  buildKnowledgeTree,
  knowledgeTreeAncestorIds,
  knowledgeTreeVisibleIds,
  reconcileKnowledgeTreeExpansion,
} from "../src/dashboard/web/components/knowledge-tree.js";
import type { KnowledgeConceptDto } from "../src/dashboard/web/data/dto.js";

const concept = (path: string, title: string, type = "Learning"): KnowledgeConceptDto => ({
  path,
  title,
  type,
  description: `${title} description`,
  tags: [],
  updated_at: 1,
});

describe("Knowledge folder tree model", () => {
  it("builds deterministic folder ancestry and sorts folders before concepts", () => {
    const model = buildKnowledgeTree([
      concept("tech/runtime/jobs.md", "Jobs"),
      concept("decisions/product.md", "Product", "Decision"),
      concept("tech/api.md", "API"),
      concept("readme.md", "Read me"),
    ]);

    expect(model.nodes.get("knowledge:root")?.children).toEqual([
      "folder:decisions", "folder:tech", "concept:readme.md",
    ]);
    expect(model.nodes.get("folder:tech")?.children).toEqual([
      "folder:tech/runtime", "concept:tech/api.md",
    ]);
    expect(model.nodes.get("folder:tech/runtime")?.children).toEqual(["concept:tech/runtime/jobs.md"]);
    expect(model.defaultExpanded).toEqual(["knowledge:root", "folder:decisions", "folder:tech"]);
  });

  it("filters concepts by searchable metadata while retaining every folder ancestor", () => {
    const model = buildKnowledgeTree([
      concept("tech/runtime/jobs.md", "Worker jobs"),
      concept("decisions/product.md", "Product framing", "Decision"),
    ]);

    expect(knowledgeTreeVisibleIds(model, "worker")).toEqual(new Set([
      "concept:tech/runtime/jobs.md", "folder:tech", "folder:tech/runtime",
    ]));
    expect(knowledgeTreeVisibleIds(model, "decision")).toEqual(new Set([
      "concept:decisions/product.md", "folder:decisions",
    ]));
    expect(knowledgeTreeVisibleIds(model, "missing")).toEqual(new Set());
    expect(knowledgeTreeVisibleIds(model, "")).toBeNull();
  });

  it("reveals a URL-selected deep concept without discarding valid expansion state", () => {
    const model = buildKnowledgeTree([
      concept("tech/runtime/jobs.md", "Worker jobs"),
      concept("decisions/product.md", "Product framing", "Decision"),
    ]);

    expect(knowledgeTreeAncestorIds("tech/runtime/jobs.md")).toEqual([
      "knowledge:root", "folder:tech", "folder:tech/runtime",
    ]);
    expect(reconcileKnowledgeTreeExpansion(model, ["knowledge:root", "folder:decisions", "folder:removed"], "tech/runtime/jobs.md")).toEqual([
      "knowledge:root", "folder:decisions", "folder:tech", "folder:tech/runtime",
    ]);
    expect(reconcileKnowledgeTreeExpansion(model, ["knowledge:root", "folder:removed"], "missing/path/doc.md")).toEqual([
      "knowledge:root",
    ]);
  });
});
