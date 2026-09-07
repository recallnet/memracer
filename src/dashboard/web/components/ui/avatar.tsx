import * as React from "react";
import type { ReactNode } from "react";
import { agentIdentity } from "../../lib/identity.js";
import { Tooltip } from "./tooltip.js";

export type ActorRole = "human" | "mediator" | "coder" | "system";

export function actorRoleDisplayName(role: string | null): string {
  return role === "mediator" ? "Frigg" : role?.trim() || "system";
}

export function actorDisplayName(name: string | null, role: ActorRole): string {
  if (role === "mediator") return "Frigg";
  return name?.trim() || (role === "human" ? "submitter" : role);
}

export function Avatar({ name, role, size = 18 }: { name: string; role: ActorRole; size?: number }) {
  const displayName = actorDisplayName(name, role);
  const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const identity = agentIdentity(displayName, role);
  return <span className="ui-avatar" aria-hidden="true" data-identity-key={identity.key} data-identity-slot={identity.slot ?? "neutral"} data-identity-icon={identity.icon} style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size / 2.4)) }}>{initials}</span>;
}

export function IdentityChip({ name, role, prefix }: { name: string; role: ActorRole; prefix?: ReactNode }) {
  const displayName = actorDisplayName(name, role);
  return <span className="actor-attribution" data-actor-role={role}><Avatar name={displayName} role={role} />{prefix ?? <span className="actor-role">{actorRoleDisplayName(role)}</span>}<b>{displayName}</b></span>;
}

/** Activity attribution follows the conversation-timeline pattern: person first, role on demand. */
export function ActorLabel({ name, role, size = 20 }: { name: string; role: ActorRole; size?: number }) {
  const displayName = actorDisplayName(name, role);
  const roleLabel = actorRoleDisplayName(role);
  const accessibleLabel = displayName === roleLabel ? displayName : `${displayName}, ${roleLabel}`;
  return <Tooltip content={roleLabel}><span className="ui-actor-label" data-actor-role={role} aria-label={accessibleLabel}><Avatar name={displayName} role={role} size={size} /><b>{displayName}</b></span></Tooltip>;
}
