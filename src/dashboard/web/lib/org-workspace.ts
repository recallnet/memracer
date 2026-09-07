/**
 * Org-scoped workspace helpers for the dashboard shell.
 * Org is derived from the selected Project; deep links stay authoritative.
 */
import type { MembershipDto } from "../data/dto.js";

export const NO_ORG_KEY = "__none__";
export const LAST_PROJECT_BY_ORG_KEY = "memracer.react.last-project-by-org";
export const ACTIVE_ORG_HINT_KEY = "memracer.react.active-org";

export interface OrgGroup {
  key: string;
  label: string;
  orgId: string | null;
  projects: MembershipDto[];
}

export function resolveOrgKey(membership: Pick<MembershipDto, "orgId"> | null | undefined): string {
  if (!membership?.orgId) return NO_ORG_KEY;
  return membership.orgId;
}

export function orgLabel(group: Pick<OrgGroup, "key" | "orgId" | "label">): string {
  return group.label;
}

function readJsonMap(key: string): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function readLastProjectByOrg(): Record<string, string> {
  return readJsonMap(LAST_PROJECT_BY_ORG_KEY);
}

export function writeLastProjectForOrg(orgKey: string, projectId: string): void {
  try {
    const next = { ...readLastProjectByOrg(), [orgKey]: projectId };
    globalThis.localStorage?.setItem(LAST_PROJECT_BY_ORG_KEY, JSON.stringify(next));
    globalThis.localStorage?.setItem(ACTIVE_ORG_HINT_KEY, orgKey);
  } catch {
    /* storage optional */
  }
}

export function readActiveOrgHint(): string | null {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_ORG_HINT_KEY) || null;
  } catch {
    return null;
  }
}

/** Group memberships by Org. Stable order: named Orgs by label then key; No organization last. */
export function groupMembershipsByOrg(memberships: MembershipDto[]): OrgGroup[] {
  const byKey = new Map<string, MembershipDto[]>();
  for (const membership of memberships) {
    const key = resolveOrgKey(membership);
    const list = byKey.get(key) ?? [];
    list.push(membership);
    byKey.set(key, list);
  }

  const nameCounts = new Map<string, number>();
  for (const [key, projects] of byKey) {
    if (key === NO_ORG_KEY) continue;
    const name = projects[0]?.orgName?.trim() || key;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const groups: OrgGroup[] = [];
  for (const [key, projects] of byKey) {
    projects.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId));
    if (key === NO_ORG_KEY) {
      groups.push({ key, label: "No organization", orgId: null, projects });
      continue;
    }
    const rawName = projects[0]?.orgName?.trim() || key;
    const label = (nameCounts.get(rawName) ?? 0) > 1 ? `${rawName} · ${key}` : rawName;
    groups.push({ key, label, orgId: key, projects });
  }

  groups.sort((a, b) => {
    if (a.key === NO_ORG_KEY) return 1;
    if (b.key === NO_ORG_KEY) return -1;
    return a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
  });
  return groups;
}

export function projectsInOrg(memberships: MembershipDto[], orgKey: string): MembershipDto[] {
  return memberships
    .filter((membership) => resolveOrgKey(membership) === orgKey)
    .sort((a, b) => a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId));
}

/** Project option labels; disambiguate when names collide within the Org. */
export function projectOptionLabel(membership: MembershipDto, siblings: MembershipDto[]): string {
  const sameName = siblings.filter((item) => item.projectName === membership.projectName);
  if (sameName.length <= 1) return membership.projectName;
  return `${membership.projectName} · ${membership.projectId}`;
}

/**
 * Prefer last-used project in the Org when still a member; otherwise the
 * lexicographically first projectId (deterministic, stable).
 */
export function pickProjectForOrg(
  memberships: MembershipDto[],
  orgKey: string,
  preferredProjectId?: string | null,
): MembershipDto | null {
  const projects = projectsInOrg(memberships, orgKey);
  if (projects.length === 0) return null;
  if (preferredProjectId) {
    const preferred = projects.find((item) => item.projectId === preferredProjectId);
    if (preferred) return preferred;
  }
  const last = readLastProjectByOrg()[orgKey];
  if (last) {
    const remembered = projects.find((item) => item.projectId === last);
    if (remembered) return remembered;
  }
  return projects.slice().sort((a, b) => a.projectId.localeCompare(b.projectId))[0] ?? null;
}

/** After membership changes: keep current project if valid; else same Org; else first group. */
export function recoverSelection(
  memberships: MembershipDto[],
  currentProjectId: string | null,
): MembershipDto | null {
  if (memberships.length === 0) return null;
  if (currentProjectId) {
    const current = memberships.find((item) => item.projectId === currentProjectId);
    if (current) return current;
  }
  const hint = readActiveOrgHint();
  if (hint) {
    const recovered = pickProjectForOrg(memberships, hint);
    if (recovered) return recovered;
  }
  const groups = groupMembershipsByOrg(memberships);
  const first = groups[0];
  if (!first) return null;
  return pickProjectForOrg(memberships, first.key);
}

/**
 * Command-palette project row: Org · Project.
 * - Org prefix disambiguates colliding org display names with ·orgId (same rule
 *   as groupMembershipsByOrg labels).
 * - Project suffix only disambiguates within the same org — cross-org name
 *   collisions are already separated by the org prefix.
 */
export function paletteProjectLabel(
  membership: MembershipDto,
  siblings: MembershipDto[] = [],
): string {
  const all = siblings.length > 0 ? siblings : [membership];
  const orgKey = resolveOrgKey(membership);
  let orgPrefix: string;
  if (orgKey === NO_ORG_KEY) {
    orgPrefix = "No organization";
  } else {
    const rawName = membership.orgName?.trim() || membership.orgId || orgKey;
    const distinctOrgKeys = new Set<string>();
    for (const item of all) {
      if (item.orgId == null) continue;
      const name = item.orgName?.trim() || item.orgId;
      if (name === rawName) distinctOrgKeys.add(item.orgId);
    }
    orgPrefix = distinctOrgKeys.size > 1 ? `${rawName} · ${orgKey}` : rawName;
  }
  const orgCohort = all.filter((item) => resolveOrgKey(item) === orgKey);
  return `${orgPrefix} · ${projectOptionLabel(membership, orgCohort)}`;
}
