import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

const badgeVariants = cva("ui-badge w-fit border text-[var(--fs-10)] font-medium", {
  variants: {
    variant: {
      neutral: "border-[var(--border-input)] text-[var(--state-parked)]",
      live: "border-[var(--state-executing)] bg-[var(--state-executing-bg)] text-[var(--state-executing)]",
      success: "border-[var(--state-done)] bg-[var(--state-done-bg)] text-[var(--state-done)]",
      danger: "border-[var(--state-blocked)] bg-[var(--state-blocked-bg)] text-[var(--state-blocked)]",
      warning: "border-[var(--state-queued)] bg-[var(--state-queued-bg)] text-[var(--state-queued)]",
    },
  },
  defaultVariants: { variant: "neutral" },
});

export function Badge({ className, variant, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

const stateTone: Record<string, string> = {
  INCUBATING: "incubating", QUEUED: "queued", HELD: "held", CLAIMED: "claimed", PLANNED: "claimed",
  EXECUTING: "executing", AWAITING_MERGE: "review", BLOCKED: "blocked", PARKED: "parked", DONE: "done",
  REVIEW: "review", VERIFY: "review", MERGED: "merged", ACCEPTED: "merged",
};

export function StatusBadge({ state, label, className }: { state: string; label?: string; className?: string }) {
  const tone = stateTone[state] ?? "parked";
  return <span className={cn("state-chip", className)} data-state={state} data-tone={tone}>{label ?? state}</span>;
}

export { badgeVariants, stateTone };
