import { describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { normalizeMemoryBody } from "../src/mediator/memory-body.js";
import { MemoryStore } from "../src/mediator/memory.js";
import { MemoryTools } from "../src/mediator/memory-tools.js";
import { openTestDb } from "./helpers/db.js";

const malformedEscaped = [
  "---\\n",
  "type: Learning\\n",
  "title: Queue repair\\n",
  "description: Repair malformed knowledge\\n",
  "tags: [queue]\\n",
  "timestamp: 2026-07-17T00:00:00.000Z\\n",
  "---\\n\\n",
  "# What we learned\\n\\nThe queue recovers.",
].join("");

const malformedDecoded = malformedEscaped.replace(/\\n/g, "\n");
const expectedBody = "# What we learned\n\nThe queue recovers.";
const escapedWithoutFrontmatter = "# Queue repair\\n\\n- Rebuild the entry.\\n- Verify the merge.";

async function setup() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('a','A')").run();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('b','B')").run();
  return { db, memory: new MemoryStore(db) };
}

async function insertRaw(
  db: Db,
  projectId: string,
  path: string,
  body: string,
  updatedAt: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO memory_docs
       (project_id, path, type, title, description, tags, body, updated_at)
     VALUES (?, ?, 'Learning', 'Queue repair', 'Repair malformed knowledge', '["queue"]', ?, ?)`,
  ).run(projectId, path, body, updatedAt);
}

describe("memory body normalization", () => {
  it("decodes literal newlines, strips leading frontmatter, and reaches a fixed point", () => {
    expect(normalizeMemoryBody(malformedEscaped)).toBe(expectedBody);
    expect(normalizeMemoryBody(malformedDecoded)).toBe(expectedBody);
    expect(normalizeMemoryBody(malformedDecoded.replace(/\n/g, "\r\n")))
      .toBe(expectedBody.replace(/\n/g, "\r\n"));
    expect(normalizeMemoryBody(escapedWithoutFrontmatter))
      .toBe("# Queue repair\n\n- Rebuild the entry.\n- Verify the merge.");

    const normalized = normalizeMemoryBody(malformedEscaped);
    expect(normalized).toBe(expectedBody);
    expect(normalizeMemoryBody(normalized)).toBe(normalized);
  });

  it("removes at most one frontmatter block and preserves the following Markdown bytes", () => {
    const firstBlock = malformedDecoded.slice(0, malformedDecoded.indexOf("# What"));
    const semanticBody = "---\nA thematic section\n---\n\n# Body";
    expect(normalizeMemoryBody(`${firstBlock}${semanticBody}`)).toBe(semanticBody);
    expect(normalizeMemoryBody(semanticBody)).toBe(semanticBody);
  });

  it("preserves semantic backslash-newline tokens in prose and code", () => {
    const cleanMixed = [
      "# Encoding reference",
      "",
      "Use a literal `\\n` token in prose and `/\\n/g` in a regex.",
      "",
      "```json",
      '{"escaped":"\\n","second":"\\n"}',
      "```",
    ].join("\n");
    expect(normalizeMemoryBody(cleanMixed)).toBe(cleanMixed);
    expect(normalizeMemoryBody('Use `\\n`, {"escaped":"\\n"}, and /\\n/g.'))
      .toBe('Use `\\n`, {"escaped":"\\n"}, and /\\n/g.');
    expect(normalizeMemoryBody('{"template":"# Title\\n\\n- item"}'))
      .toBe('{"template":"# Title\\n\\n- item"}');
    expect(normalizeMemoryBody("Regex literals: /\\n- / and /\\n# /"))
      .toBe("Regex literals: /\\n- / and /\\n# /");

    const frontmatter = "---\ntype: Reference\ntitle: Encoding\n---\n\n";
    expect(normalizeMemoryBody(`${frontmatter}${cleanMixed}`)).toBe(cleanMixed);
  });

  it("normalizes direct upserts without changing clean body content", async () => {
    const { memory } = await setup();
    await memory.upsert("a", {
      path: "learnings/escaped.md",
      type: "Learning",
      title: "Escaped",
      description: "Escaped body",
      tags: [],
      body: malformedEscaped,
    });
    await memory.upsert("a", {
      path: "learnings/clean.md",
      type: "Learning",
      title: "Clean",
      description: "Clean body",
      tags: [],
      body: "# What we learned\n\nAlready clean.",
    });

    expect((await memory.get("a", "learnings/escaped.md"))?.body).toBe(expectedBody);
    expect((await memory.get("a", "learnings/clean.md"))?.body).toBe("# What we learned\n\nAlready clean.");
  });

  it("normalizes scoped okf_write and okf_update through the primary upsert gate", async () => {
    const { db, memory } = await setup();
    const tools = new MemoryTools(db).bind("a");
    expect(await tools.dispatch("okf_write", {
      path: "learnings/scoped.md",
      type: "Learning",
      title: "Scoped",
      description: "Scoped body",
      tags: [],
      body: malformedEscaped,
    })).toMatchObject({ ok: true });
    expect((await memory.get("a", "learnings/scoped.md"))?.body).toBe(expectedBody);

    expect(await tools.dispatch("okf_update", {
      path: "learnings/scoped.md",
      body: malformedDecoded.replace("The queue recovers.", "The update recovers."),
    })).toMatchObject({ ok: true });
    expect((await memory.get("a", "learnings/scoped.md"))?.body)
      .toBe("# What we learned\n\nThe update recovers.");
    expect(await memory.get("b", "learnings/scoped.md")).toBeNull();
  });

  it("repairs every project transactionally while preserving metadata and timestamps", async () => {
    const { db, memory } = await setup();
    await insertRaw(db, "a", "learnings/escaped.md", malformedEscaped, 101);
    await insertRaw(db, "b", "learnings/decoded.md", malformedDecoded, 202);
    await insertRaw(db, "b", "learnings/clean.md", "# What we learned\n\nAlready clean.", 303);
    await insertRaw(db, "a", "learnings/literal-token.md", "# Reference\n\nUse `\\n` literally.", 404);

    const before = await db.prepare(
      "SELECT project_id, path, type, title, description, tags, updated_at FROM memory_docs ORDER BY project_id, path",
    ).all();
    expect(await memory.repairMalformedBodies()).toEqual({ scanned: 4, repaired: 2 });
    const after = await db.prepare(
      "SELECT project_id, path, type, title, description, tags, updated_at FROM memory_docs ORDER BY project_id, path",
    ).all();

    expect(after).toEqual(before);
    expect((await memory.get("a", "learnings/escaped.md"))?.body).toBe(expectedBody);
    expect((await memory.get("b", "learnings/decoded.md"))?.body).toBe(expectedBody);
    expect((await memory.get("b", "learnings/clean.md"))?.body).toBe("# What we learned\n\nAlready clean.");
    expect((await memory.get("a", "learnings/literal-token.md"))?.body).toBe("# Reference\n\nUse `\\n` literally.");
    expect(await memory.repairMalformedBodies()).toEqual({ scanned: 4, repaired: 0 });
  });

  it("does not overwrite a body that changes after the repair scan", async () => {
    const { db } = await setup();
    await insertRaw(db, "a", "learnings/racing.md", malformedEscaped, 404);
    let interleaved = false;
    const racingDb: Db = {
      dialect: db.dialect,
      authDatabase: () => db.authDatabase(),
      close: () => db.close(),
      exec: (sql) => db.exec(sql),
      transaction: (fn) => db.transaction(fn),
      isInTransaction: () => db.isInTransaction(),
      prepare: (sql) => {
        const statement = db.prepare(sql);
        if (!sql.startsWith("UPDATE memory_docs SET body=? WHERE")) return statement;
        return {
          get: (...params) => statement.get(...params),
          all: (...params) => statement.all(...params),
          run: async (...params) => {
            if (!interleaved) {
              interleaved = true;
              await db.prepare(
                "UPDATE memory_docs SET body=? WHERE project_id=? AND path=?",
              ).run("# What we learned\n\nA newer writer won.", params[1], params[2]);
            }
            return statement.run(...params);
          },
        };
      },
    };

    expect(await new MemoryStore(racingDb).repairMalformedBodies()).toEqual({ scanned: 1, repaired: 0 });
    expect(await db.prepare(
      "SELECT body, updated_at FROM memory_docs WHERE project_id='a' AND path='learnings/racing.md'",
    ).get()).toEqual({ body: "# What we learned\n\nA newer writer won.", updated_at: 404 });
  });
});
