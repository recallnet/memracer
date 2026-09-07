import { readFileSync, writeFileSync } from "node:fs";
import { openDb, openPostgresDb } from "../src/db.js";
import { groomFixtures } from "../src/eval/fixtures.js";
import type { GroomQualityCategory } from "../src/eval/groom-quality.js";

interface Label {
  threadId: number;
  category: GroomQualityCategory;
  seedFixture: string;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const labels = JSON.parse(readFileSync(argument("--labels"), "utf8")) as Label[];
if (labels.length < 100) throw new Error("at least 100 curated historical labels are required");
const fixtureNames = new Set(groomFixtures.map((fixture) => fixture.name));
const db = process.env.DATABASE_URL
  ? await openPostgresDb(process.env.DATABASE_URL)
  : openDb(process.env.MEMRACER_DB_PATH ?? "memracer.db");

const output = [];
for (const [index, label] of labels.entries()) {
  if (!fixtureNames.has(label.seedFixture)) throw new Error(`unknown redacted seed fixture ${label.seedFixture}`);
  const row = await db.prepare(
    `SELECT m.structured FROM threads th
     JOIN thread_messages m ON m.thread_id=th.id
     WHERE th.id=? AND th.kind='groom' AND m.role='mediator' AND m.structured IS NOT NULL
     ORDER BY m.id DESC LIMIT 1`,
  ).get<{ structured: string }>(label.threadId);
  if (!row) throw new Error(`historical groom thread ${label.threadId} has no structured mediator verdict`);
  JSON.parse(row.structured);
  output.push({
    id: `historical-${String(index + 1).padStart(3, "0")}`,
    category: label.category,
    seedFixture: label.seedFixture,
    source: "historical_redacted",
  });
}

const counts = output.reduce<Record<string, number>>((acc, item) => {
  acc[item.category] = (acc[item.category] ?? 0) + 1;
  return acc;
}, {});
if ((counts.happy ?? 0) < 55 || (counts.edge ?? 0) < 15 || (counts.clarify_refusal ?? 0) < 10 || (counts.historical_failure ?? 0) < 10) {
  throw new Error(`historical labels do not meet the required category balance: ${JSON.stringify(counts)}`);
}
writeFileSync(argument("--out"), `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
await db.close();
console.log(`exported ${output.length} redacted historical groom labels: ${JSON.stringify(counts)}`);
