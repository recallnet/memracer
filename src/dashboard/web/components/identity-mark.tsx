import * as React from "react";
import type { CSSProperties } from "react";
import type { IdentityDescriptor, IdentityIcon } from "../lib/identity.js";
import { IdentityChip, actorDisplayName } from "./ui/avatar.js";

const clipPaths: Record<IdentityIcon, string> = {
  diamond: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)",
  circle: "circle(48%)",
  chevron: "polygon(0 0, 58% 0, 100% 50%, 58% 100%, 0 100%, 42% 50%)",
  hexagon: "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)",
  square: "inset(8%)",
};

export interface IdentityMarkProps {
  identity: IdentityDescriptor;
  size?: number;
  labelled?: boolean;
}

export function IdentityMark({ identity, size = 12, labelled = false }: IdentityMarkProps) {
  const style = {
    width: size,
    height: size,
    background: "var(--identity-mark, var(--text-dim))",
    clipPath: clipPaths[identity.icon],
    flex: "none",
  } satisfies CSSProperties;
  return <span
    role={labelled ? "img" : undefined}
    aria-label={labelled ? identity.label : undefined}
    aria-hidden={labelled ? undefined : true}
    data-identity-key={identity.key}
    data-identity-slot={identity.slot ?? "neutral"}
    data-identity-icon={identity.icon}
    style={style}
  />;
}

export function ActorAttribution({ name, role }: { name: string | null; role: "human" | "mediator" | "coder" | "system" }) {
  return <IdentityChip name={actorDisplayName(name, role)} role={role} />;
}
