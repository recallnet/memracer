export type IdentityColor = "neutral";
export type IdentityIcon = "diamond" | "circle" | "chevron" | "hexagon" | "square";

export interface IdentityDescriptor {
  kind: "task" | "agent";
  key: string;
  label: string;
  color: IdentityColor;
  icon: IdentityIcon;
  slot: number | null;
}

function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

function slotFor(value: string): number { return hash(value) % 5; }

export function taskIdentity(taskId: number | null): IdentityDescriptor {
  if (!Number.isInteger(taskId) || (taskId ?? 0) <= 0) {
    return { kind: "task", key: "task:unknown", label: "Unassigned task", color: "neutral", icon: "square", slot: null };
  }
  const key = `task:${taskId}`;
  const slot = slotFor(key);
  return { kind: "task", key, label: `Task ${taskId}`, color: "neutral", icon: "diamond", slot };
}

export function agentIdentity(name: string | null, role: string | null): IdentityDescriptor {
  const label = name?.trim();
  if (!label) return { kind: "agent", key: "agent:unknown", label: "Unassigned", color: "neutral", icon: "square", slot: null };
  const icons: Record<string, IdentityIcon> = { human: "circle", coder: "chevron", mediator: "hexagon" };
  const icon = role ? icons[role] : undefined;
  const key = `agent:${label.toLocaleLowerCase("en-US")}`;
  if (!icon) return { kind: "agent", key, label, color: "neutral", icon: "square", slot: null };
  const slot = slotFor(key);
  return { kind: "agent", key, label, color: "neutral", icon, slot };
}

export function threadRole(kind: string): "human" | "mediator" {
  return kind === "submission" ? "human" : "mediator";
}
