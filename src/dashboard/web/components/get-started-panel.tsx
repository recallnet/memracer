import * as React from "react";
import { useCallback, useMemo, useState } from "react";
import {
  BILLING_GATE_BODY,
  BILLING_GATE_CTA,
  BILLING_GATE_TITLE,
  GET_STARTED_BODY,
  GET_STARTED_STEPS,
  GET_STARTED_TITLE,
  HOW_THIS_WORKS_HREF,
  HOW_THIS_WORKS_LABEL,
} from "../../public/onboarding-copy.js";
import {
  dismissGetStarted,
  getStartedMode,
  shouldShowGetStarted,
  type ProjectSeatReadiness,
} from "../lib/seat-readiness.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";

export function GetStartedPanel({
  projectId,
  readiness,
  storage = typeof localStorage !== "undefined" ? localStorage : null,
  onOpenSettings,
  onSetupBilling,
}: {
  projectId: string;
  /** null/undefined = loading/unknown → panel hidden */
  readiness: ProjectSeatReadiness | null | undefined;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  onOpenSettings?: () => void;
  onSetupBilling?: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const visible = useMemo(() => {
    if (dismissed) return false;
    return shouldShowGetStarted(projectId, readiness, storage);
  }, [dismissed, projectId, readiness, storage]);

  const onDismiss = useCallback(() => {
    dismissGetStarted(projectId, storage);
    setDismissed(true);
  }, [projectId, storage]);

  if (!visible || readiness == null) return null;

  const mode = getStartedMode(readiness);

  if (mode === "billing") {
    return (
      <Card className="get-started-panel" aria-label={BILLING_GATE_TITLE} data-testid="get-started-panel">
        <header className="get-started-panel-header">
          <div>
            <span className="section-kicker">Onboarding</span>
            <h2>{BILLING_GATE_TITLE}</h2>
            <p>{BILLING_GATE_BODY}</p>
          </div>
          <Button type="button" variant="ghost" onClick={onDismiss} aria-label="Dismiss get started">
            Dismiss
          </Button>
        </header>
        <div className="get-started-actions">
          {onSetupBilling ? (
            <Button type="button" onClick={onSetupBilling}>
              {BILLING_GATE_CTA}
            </Button>
          ) : null}
          <a className="get-started-faq-link" href={HOW_THIS_WORKS_HREF}>
            {HOW_THIS_WORKS_LABEL}
          </a>
        </div>
      </Card>
    );
  }

  return (
    <Card className="get-started-panel" aria-label={GET_STARTED_TITLE} data-testid="get-started-panel">
      <header className="get-started-panel-header">
        <div>
          <span className="section-kicker">Onboarding</span>
          <h2>{GET_STARTED_TITLE}</h2>
          <p>{GET_STARTED_BODY}</p>
        </div>
        <Button type="button" variant="ghost" onClick={onDismiss} aria-label="Dismiss get started">
          Dismiss
        </Button>
      </header>
      <ol className="get-started-steps">
        {GET_STARTED_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="get-started-actions">
        {onOpenSettings ? (
          <Button type="button" onClick={onOpenSettings}>
            Open Settings
          </Button>
        ) : null}
        <a className="get-started-faq-link" href={HOW_THIS_WORKS_HREF}>
          {HOW_THIS_WORKS_LABEL}
        </a>
      </div>
    </Card>
  );
}
