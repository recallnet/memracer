// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardErrorBoundary } from "../src/dashboard/web/components/error-boundary.js";

function TestView({ fail }: { fail: boolean }) {
  if (fail) throw new Error("render failed");
  return createElement("p", null, "Recovered view");
}

describe("dashboard error boundary", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("reports an honest render failure and resets only when its input identity changes", async () => {
    await act(async () => root.render(createElement(DashboardErrorBoundary, {
      resetKey: "session:1",
      heading: "Activity couldn't load",
      children: createElement(TestView, { fail: true }),
    })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Activity couldn't load");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("rendering error");
    expect(host.querySelector(".error-digest")?.textContent).toMatch(/^Error ID: render-[0-9a-f]{8}$/);
    expect(host.querySelector("button")).toBeNull();
    expect(console.error).toHaveBeenCalledWith("Dashboard render failed", expect.objectContaining({
      digest: expect.stringMatching(/^render-[0-9a-f]{8}$/),
      error: expect.any(Error),
    }));

    await act(async () => root.render(createElement(DashboardErrorBoundary, {
      resetKey: "session:2",
      heading: "Activity couldn't load",
      children: createElement(TestView, { fail: false }),
    })));
    expect(host.textContent).toBe("Recovered view");
  });
});
