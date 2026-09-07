import * as React from "react";
import type { HTMLAttributes } from "react";
import { ExternalLink } from "lucide-react";
import { prPresentation } from "../lib/home-model.js";
import { cn } from "../lib/cn.js";
import { Badge } from "./ui/badge.js";

export interface TaskPrStatusProps extends HTMLAttributes<HTMLDivElement> {
  resultPrUrl: string | null | undefined;
  resultPrNumber?: number | null;
  prVerification?: string | null;
}

/**
 * Compact PR chrome for queue rows and task detail: external PR link plus
 * merge + CI chips derived from stored pr_verification. Renders nothing when
 * there is no result_pr_url.
 */
export function TaskPrStatus({
  resultPrUrl,
  resultPrNumber,
  prVerification,
  className,
  ...props
}: TaskPrStatusProps) {
  if (!resultPrUrl) return null;
  const { merge, ci, mergeTone, ciTone } = prPresentation(prVerification);
  const label = resultPrNumber != null ? `PR #${resultPrNumber}` : "PR";
  return (
    <div className={cn("task-pr-status", className)} data-testid="task-pr-status" {...props}>
      <a
        className="task-pr-link"
        href={resultPrUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${label} on GitHub`}
        onClick={(event) => event.stopPropagation()}
      >
        <span>{label}</span>
        <ExternalLink size={12} aria-hidden="true" />
      </a>
      {merge ? <Badge variant={mergeTone} data-pr-merge={merge}>{merge}</Badge> : null}
      {ci ? <Badge variant={ciTone} data-pr-ci={ci}>{ci}</Badge> : null}
    </div>
  );
}
