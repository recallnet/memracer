import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Registry, type SeatRecord } from "../src/registry.js";

const rec: SeatRecord = {
  project: "memracer",
  role: "coder",
  folder: "/repo/wt/coder",
  harness: "claude",
  keyId: "k1",
};

describe("Registry", () => {
  it("adds and lists a record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memracer-reg-"));
    const reg = new Registry(join(dir, "seats.json"));
    reg.add(rec);
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]).toEqual(rec);
  });

  it("upserts by (folder, harness)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memracer-reg-"));
    const reg = new Registry(join(dir, "seats.json"));
    reg.add(rec);
    reg.add({ ...rec, keyId: "k2" });
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.keyId).toBe("k2");
  });

  it("returns an empty list when the file is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memracer-reg-"));
    const reg = new Registry(join(dir, "missing.json"));
    expect(reg.list()).toEqual([]);
  });
});
