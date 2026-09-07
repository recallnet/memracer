import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GetStartedPanel } from "../src/dashboard/web/components/get-started-panel.js";
import { BILLING_GATE_CTA, BILLING_GATE_TITLE, GET_STARTED_TITLE } from "../src/dashboard/public/onboarding-copy.js";

describe("GetStartedPanel", () => {
  it("renders when project readiness is incomplete greenfield", () => {
    const html = renderToStaticMarkup(
      <GetStartedPanel
        projectId="demo"
        readiness={{ factoryReady: false, humanSeats: 1, coderSeats: 0, hasTaskHistory: false, friggReady: false }}
        storage={null}
      />,
    );
    expect(html).toContain(GET_STARTED_TITLE);
    expect(html).toContain("get-started-panel");
    expect(html).toContain("/faq");
  });

  it("shows the billing gate once seats connect but no active plan", () => {
    const html = renderToStaticMarkup(
      <GetStartedPanel
        projectId="demo"
        readiness={{ factoryReady: true, humanSeats: 2, coderSeats: 1, hasTaskHistory: false, friggReady: false }}
        storage={null}
        onSetupBilling={() => {}}
      />,
    );
    expect(html).toContain(BILLING_GATE_TITLE);
    expect(html).toContain(BILLING_GATE_CTA);
  });

  it("hides when factory is ready and billing is active", () => {
    const html = renderToStaticMarkup(
      <GetStartedPanel
        projectId="demo"
        readiness={{ factoryReady: true, humanSeats: 2, coderSeats: 1, hasTaskHistory: false, friggReady: true }}
        storage={null}
      />,
    );
    expect(html).toBe("");
  });

  it("hides while readiness is loading/unknown", () => {
    expect(renderToStaticMarkup(<GetStartedPanel projectId="demo" readiness={null} storage={null} />)).toBe("");
    expect(
      renderToStaticMarkup(<GetStartedPanel projectId="demo" readiness={undefined} storage={null} />),
    ).toBe("");
  });

  it("keeps teaching when task history exists but no coder seat yet", () => {
    const html = renderToStaticMarkup(
      <GetStartedPanel
        projectId="demo"
        readiness={{ factoryReady: false, humanSeats: 1, coderSeats: 0, hasTaskHistory: true, friggReady: false }}
        storage={null}
      />,
    );
    expect(html).toContain(GET_STARTED_TITLE);
  });
});
