import { describe, expect, it } from "vitest";
import * as typed from "../src/dashboard/web/lib/url-state.js";

describe("canonical dashboard URL state", () => {
  it("parses the complete schema and normalizes invalid values", () => {
    expect(typed.parseUrlState("?project=p2&view=knowledge&task=12&thread=8&concept=tech%2Fapi.md")).toEqual({
      project: "p2", org: null, view: "knowledge", task: 12, thread: 8, concept: "tech/api.md",
      state: null, agent: null, sort: null, direction: null,
    });
    expect(typed.parseUrlState("?project=&view=nope&task=-2&thread=3.5&concept=&state=NOPE&agent=&sort=nope&direction=sideways")).toEqual({
      project: null, org: null, view: "dashboard", task: null, thread: null, concept: null,
      state: null, agent: null, sort: null, direction: null,
    });
    expect(typed.parseUrlState("?project=p1&view=team&thread=0004&state=EXECUTING&agent=codex%2Fone")).toMatchObject({
      project: "p1", view: "team", thread: 4, state: "EXECUTING", agent: "codex/one",
    });
    expect(typed.parseUrlState("?project=p1&view=org-settings&org=acme")).toMatchObject({
      project: "p1", org: "acme", view: "org-settings",
    });
    expect(typed.serializeUrlState({ project: "p1", org: "acme", view: "org-settings" })).toBe(
      "?project=p1&org=acme&view=org-settings",
    );
  });

  it("adds intentional queue sorting after every legacy parameter", () => {
    const parsed = typed.parseUrlState("?project=p1&view=dashboard&state=EXECUTING&agent=ada&sort=updated&direction=asc");
    expect(parsed).toMatchObject({ project: "p1", state: "EXECUTING", agent: "ada", sort: "updated", direction: "asc" });
    expect(typed.serializeUrlState(parsed)).toBe("?project=p1&view=dashboard&state=EXECUTING&agent=ada&sort=updated&direction=asc");
    expect(typed.parseUrlState("?sort=nope&direction=sideways")).toMatchObject({ sort: null, direction: null });
  });

  it("serializes and builds hrefs in the canonical parameter order", () => {
    const state = {
      concept: "tech/API state.md",
      thread: 8,
      project: "team/project",
      view: "knowledge" as const,
      task: 12,
      state: "BLOCKED" as const,
      agent: "cc/1",
    };
    expect(typed.serializeUrlState(state)).toBe("?project=team%2Fproject&view=knowledge&task=12&thread=8&concept=tech%2FAPI+state.md&state=BLOCKED&agent=cc%2F1");
    expect(typed.dashboardHref(state)).toBe("/dashboard?project=team%2Fproject&view=knowledge&task=12&thread=8&concept=tech%2FAPI+state.md&state=BLOCKED&agent=cc%2F1");
  });

  it.each([
    { mode: "push" as const, selection: { project: "p1", view: "dashboard" as const }, search: "" },
    { mode: "replace" as const, selection: { project: "p1", view: "team" as const }, search: "?project=p1&view=dashboard" },
    { mode: "push" as const, selection: { project: "p1", view: "dashboard" as const }, search: "?project=p1&view=dashboard" },
  ])("performs one $mode write from $search and skips an identical URL", ({ mode, selection, search }) => {
    const makeFixture = () => {
      const calls: string[] = [];
      return {
        calls,
        location: { pathname: "/dashboard", search, hash: "#top" } as Location,
        history: {
          pushState: (_state: unknown, _title: string, href: string | URL | null) => calls.push(`push:${href}`),
          replaceState: (_state: unknown, _title: string, href: string | URL | null) => calls.push(`replace:${href}`),
        } as Pick<History, "pushState" | "replaceState">,
      };
    };
    const newFixture = makeFixture();
    const newResult = typed.writeUrlState(mode, selection, newFixture.location, newFixture.history);
    const expectedHref = `/dashboard?project=p1&view=${selection.view}#top`;
    if (search === `?project=p1&view=${selection.view}`) {
      expect(newResult).toBe(false);
      expect(newFixture.calls).toEqual([]);
    } else {
      expect(newResult).toBe(true);
      expect(newFixture.calls).toEqual([`${mode}:${expectedHref}`]);
    }
  });
});
