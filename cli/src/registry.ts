import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** One locally-configured seat, keyed by (folder, harness). */
export interface SeatRecord {
  project: string;
  role: string;
  folder: string;
  harness: "claude" | "grok" | "codex";
  keyId: string;
  /** Set only for Codex seats, which read their token from this env var. */
  envVar?: string;
}

const DEFAULT_FILE = join(homedir(), ".memracer", "seats.json");

/** A JSON-file registry of the seats configured on this machine. */
export class Registry {
  constructor(private readonly file: string = DEFAULT_FILE) {}

  list(): SeatRecord[] {
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as SeatRecord[]) : [];
    } catch {
      return [];
    }
  }

  /** Upsert by (folder, harness); rewrites the file with mode 0o600. */
  add(rec: SeatRecord): void {
    const records = this.list().filter(
      (r) => !(r.folder === rec.folder && r.harness === rec.harness),
    );
    records.push(rec);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  }
}
