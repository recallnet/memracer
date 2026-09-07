import { afterEach, describe, expect, it, vi } from "vitest";
import type { MembershipDto } from "../src/dashboard/web/data/dto.js";
import {
  groupMembershipsByOrg,
  NO_ORG_KEY,
  paletteProjectLabel,
  pickProjectForOrg,
  projectOptionLabel,
  recoverSelection,
  resolveOrgKey,
  writeLastProjectForOrg,
} from "../src/dashboard/web/lib/org-workspace.js";

const member = (overrides: Partial<MembershipDto> & Pick<MembershipDto, "projectId" | "projectName">): MembershipDto => ({
  repo: null,
  role: "human",
  orgId: null,
  orgName: null,
  ...overrides,
});

describe("org workspace helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("groups by org and labels null-org memberships as No organization", () => {
    const groups = groupMembershipsByOrg([
      member({ projectId: "p1", projectName: "Alpha", orgId: "o1", orgName: "Acme" }),
      member({ projectId: "p2", projectName: "Beta", orgId: null, orgName: null }),
      member({ projectId: "p3", projectName: "Gamma", orgId: "o1", orgName: "Acme" }),
    ]);
    expect(groups.map((group) => group.key)).toEqual(["o1", NO_ORG_KEY]);
    expect(groups[0]?.projects.map((item) => item.projectId)).toEqual(["p1", "p3"]);
    expect(groups[1]?.label).toBe("No organization");
  });

  it("disambiguates duplicate Org and Project names", () => {
    const groups = groupMembershipsByOrg([
      member({ projectId: "p1", projectName: "Factory", orgId: "o1", orgName: "Acme" }),
      member({ projectId: "p2", projectName: "Factory", orgId: "o2", orgName: "Acme" }),
    ]);
    expect(groups.map((group) => group.label).sort()).toEqual(["Acme · o1", "Acme · o2"]);
    const acme = groups.find((group) => group.key === "o1")!.projects;
    // single project in that org — no project disambiguation needed
    expect(projectOptionLabel(acme[0]!, acme)).toBe("Factory");
    const siblings = [
      member({ projectId: "a", projectName: "Dup", orgId: "o1", orgName: "Acme" }),
      member({ projectId: "b", projectName: "Dup", orgId: "o1", orgName: "Acme" }),
    ];
    expect(projectOptionLabel(siblings[0]!, siblings)).toBe("Dup · a");
  });

  it("prefers last-used project then deterministic projectId", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } satisfies Storage);

    const memberships = [
      member({ projectId: "z-last", projectName: "Z", orgId: "o1", orgName: "Acme" }),
      member({ projectId: "a-first", projectName: "A", orgId: "o1", orgName: "Acme" }),
    ];
    expect(pickProjectForOrg(memberships, "o1")?.projectId).toBe("a-first");
    writeLastProjectForOrg("o1", "z-last");
    expect(pickProjectForOrg(memberships, "o1")?.projectId).toBe("z-last");
    expect(pickProjectForOrg(memberships, "o1", "a-first")?.projectId).toBe("a-first");
  });

  it("recovers selection when current project is gone", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } satisfies Storage);
    writeLastProjectForOrg("o2", "keep");
    const memberships = [
      member({ projectId: "keep", projectName: "Keep", orgId: "o2", orgName: "Beta" }),
      member({ projectId: "other", projectName: "Other", orgId: "o1", orgName: "Alpha" }),
    ];
    expect(recoverSelection(memberships, "missing")?.projectId).toBe("keep");
    expect(resolveOrgKey(memberships[0]!)).toBe("o2");
    expect(paletteProjectLabel(memberships[0]!)).toBe("Beta · Keep");
  });

  it("palette labels use Org · Project and disambiguate colliding names", () => {
    const a = member({ projectId: "a", projectName: "Dup", orgId: "o1", orgName: "Acme" });
    const b = member({ projectId: "b", projectName: "Dup", orgId: "o1", orgName: "Acme" });
    const unique = member({ projectId: "c", projectName: "Solo", orgId: "o1", orgName: "Acme" });
    const siblings = [a, b, unique];
    expect(paletteProjectLabel(unique, siblings)).toBe("Acme · Solo");
    expect(paletteProjectLabel(a, siblings)).toBe("Acme · Dup · a");
    expect(paletteProjectLabel(b, siblings)).toBe("Acme · Dup · b");
    expect(paletteProjectLabel(member({ projectId: "x", projectName: "Lone", orgId: null, orgName: null }))).toBe(
      "No organization · Lone",
    );
  });

  it("palette org prefix disambiguates colliding org names; no redundant projectId across orgs", () => {
    const o1 = member({ projectId: "p1", projectName: "Factory", orgId: "o1", orgName: "Acme" });
    const o2 = member({ projectId: "p2", projectName: "Factory", orgId: "o2", orgName: "Acme" });
    const all = [o1, o2];
    // Org names collide → ·orgId on prefix; same project name across orgs does not need ·projectId.
    expect(paletteProjectLabel(o1, all)).toBe("Acme · o1 · Factory");
    expect(paletteProjectLabel(o2, all)).toBe("Acme · o2 · Factory");
    // Unique org name: no ·orgId; unique project name in org: no ·projectId.
    const solo = member({ projectId: "s1", projectName: "Solo", orgId: "ox", orgName: "Unique Co" });
    expect(paletteProjectLabel(solo, [...all, solo])).toBe("Unique Co · Solo");
  });
});
