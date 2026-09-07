import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

const buttonVariants = cva(
  "ui-button inline-flex items-center justify-center border text-[var(--fs-11)] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "border-[var(--accent)] bg-[var(--accent)] text-[var(--white)] hover:border-[var(--live)]",
        secondary: "border-[var(--border-input)] bg-[var(--panel-2)] text-[var(--text)] hover:border-[var(--live)] hover:text-[var(--white)]",
        ghost: "border-transparent text-muted-foreground hover:bg-[var(--hover)] hover:text-foreground",
        danger: "border-[var(--state-blocked)] bg-transparent text-[var(--state-blocked)] hover:bg-[var(--state-blocked-bg)]",
      },
      size: { sm: "ui-button-sm", default: "", lg: "ui-button-lg", icon: "ui-button-icon" },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ asChild, className, variant, size, ...props }: ButtonProps) {
  const Component = asChild ? Slot : "button";
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
