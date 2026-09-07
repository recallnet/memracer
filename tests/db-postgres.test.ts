// Dedicated adversarial suite for the hand-rolled ?->$n placeholder rewrite
// (#81 backfill). The rewrite must number only true bind placeholders and step
// over every SQL construct where a literal `?` can legally appear: single- and
// double-quoted strings (with '' / "" escapes), -- line comments, and casts.
// A miscount here would silently shift every downstream parameter — a data-
// corruption bug — so the edge cases below are the real risk surface.
import { describe, expect, it } from "vitest";
import { toPgPlaceholders } from "../src/db/postgres.js";

describe("toPgPlaceholders", () => {
  it("numbers a plain sequence of placeholders 1..n in order", () => {
    expect(toPgPlaceholders("INSERT INTO t (a,b,c) VALUES (?,?,?)")).toBe(
      "INSERT INTO t (a,b,c) VALUES ($1,$2,$3)",
    );
  });

  it("leaves an embedded ? inside a single-quoted value untouched", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE label = 'why?' AND id = ?")).toBe(
      "SELECT * FROM t WHERE label = 'why?' AND id = $1",
    );
  });

  it("does not consume placeholders after a doubled '' escape inside a literal", () => {
    // 'it''s ?' is ONE literal containing an escaped quote and a literal ?;
    // the trailing ? outside it is the only real placeholder.
    expect(toPgPlaceholders("SELECT 'it''s ?' AS note, ? FROM t")).toBe(
      "SELECT 'it''s ?' AS note, $1 FROM t",
    );
  });

  it("leaves a ? inside a double-quoted identifier untouched", () => {
    expect(toPgPlaceholders('SELECT "weird?col", ? FROM t')).toBe('SELECT "weird?col", $1 FROM t');
  });

  it("handles a doubled \"\" escape inside a quoted identifier", () => {
    expect(toPgPlaceholders('SELECT "a""?""b", ? FROM t')).toBe('SELECT "a""?""b", $1 FROM t');
  });

  it("ignores ? inside a -- line comment but resumes on the next line", () => {
    expect(toPgPlaceholders("SELECT ? -- is this ? a comment\n, ?")).toBe(
      "SELECT $1 -- is this ? a comment\n, $2",
    );
  });

  it("treats a trailing -- comment with no newline as inert to EOL", () => {
    expect(toPgPlaceholders("SELECT ? FROM t -- tail ? ?")).toBe("SELECT $1 FROM t -- tail ? ?");
  });

  it("does not mistake a :: cast for a placeholder and still numbers real ones", () => {
    expect(toPgPlaceholders("SELECT id::text, ? FROM t WHERE ts::bigint > ?")).toBe(
      "SELECT id::text, $1 FROM t WHERE ts::bigint > $2",
    );
  });

  it("handles quotes nested across mixed constructs in one statement", () => {
    const sql = "UPDATE t SET note = 'a?b', tag = \"c?d\" WHERE k = ? AND m = ? -- ? ignored\n AND z = ?";
    expect(toPgPlaceholders(sql)).toBe(
      "UPDATE t SET note = 'a?b', tag = \"c?d\" WHERE k = $1 AND m = $2 -- ? ignored\n AND z = $3",
    );
  });

  it("returns SQL with no placeholders unchanged", () => {
    expect(toPgPlaceholders("SELECT 1")).toBe("SELECT 1");
  });

  it("numbers many placeholders monotonically past 9 (no single-digit assumption)", () => {
    const sql = "VALUES (" + Array.from({ length: 12 }, () => "?").join(",") + ")";
    const out = toPgPlaceholders(sql);
    expect(out).toContain("$10,$11,$12");
    expect(out.startsWith("VALUES ($1,$2,")).toBe(true);
  });
});
