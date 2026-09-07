import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IdentityMark } from "../src/dashboard/web/components/identity-mark.js";
import { agentIdentity, taskIdentity } from "../src/dashboard/web/lib/identity.js";

describe("dashboard identity projection", () => {
  it("uses one task geometry while keeping nearby ids distinct by readable key", () => {
    expect(taskIdentity(143)).toEqual(taskIdentity(143));
    expect(taskIdentity(143)).not.toEqual(taskIdentity(144));
    expect(taskIdentity(143)).toMatchObject({ kind: "task", key: "task:143", label: "Task 143" });
    expect(new Set(Array.from({ length: 20 }, (_, offset) => taskIdentity(140 + offset).icon))).toEqual(new Set(["diamond"]));
    expect(taskIdentity(143).color).toBe("neutral");
  });

  it("uses neutral role geometry without competing with state colors", () => {
    expect(agentIdentity("codex-1", "coder")).toEqual(agentIdentity("codex-1", "coder"));
    expect(agentIdentity("codex-1", "coder")).toMatchObject({ kind: "agent", key: "agent:codex-1", icon: "chevron", label: "codex-1" });
    expect(agentIdentity(" Codex-1 ", "coder")).toMatchObject({ key: "agent:codex-1", slot: agentIdentity("codex-1", "coder").slot, icon: "chevron" });
    expect(agentIdentity("ada", "human").icon).toBe("circle");
    expect(agentIdentity("mediator", "mediator").icon).toBe("hexagon");
    expect(agentIdentity("codex-1", "coder").color).toBe("neutral");
  });

  it("has a neutral fallback for missing or unknown agent identity", () => {
    expect(agentIdentity(null, null)).toEqual({ kind: "agent", key: "agent:unknown", label: "Unassigned", color: "neutral", icon: "square", slot: null });
    expect(agentIdentity("worker", "unknown")).toMatchObject({ key: "agent:worker", color: "neutral", icon: "square", slot: null });
    expect(taskIdentity(0)).toMatchObject({ key: "task:unknown", color: "neutral", slot: null });
  });

  it("emits a stable cross-surface DOM contract", () => {
    const identity = taskIdentity(143);
    const html = renderToStaticMarkup(createElement(IdentityMark, { identity, labelled: true }));
    expect(html).toContain('data-identity-key="task:143"');
    expect(html).toContain(`data-identity-slot="${identity.slot}"`);
    expect(html).toContain(`data-identity-icon="${identity.icon}"`);
    expect(html).toContain("var(--identity-mark, var(--text-dim))");
    expect(html).toContain('aria-label="Task 143"');
    expect(html).not.toContain("title=");
  });
});
