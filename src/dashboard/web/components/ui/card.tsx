import * as React from "react";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn(className, "ui-card")} {...props} />;
}

export function SidebarSection({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn(className, "ui-sidebar-section")} {...props} />;
}
