export interface IdleDbSnapshot {
  tasks: unknown[];
  attempts: unknown[];
  projects: unknown[];
}

export interface ClaimReturn {
  agent: string;
  taskId: number | null;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

export function idleSnapshotsUnchanged(
  baseline: IdleDbSnapshot,
  observed: IdleDbSnapshot[],
): boolean {
  const expected = canonical(baseline);
  return observed.length > 0 && observed.every((snapshot) => canonical(snapshot) === expected);
}

export function hasUniqueCompetingClaimSplit(input: {
  claims: ClaimReturn[];
  primaryAgent: string;
  competitorAgent: string;
  raceTaskId: number;
  lifecycleTaskId: number;
}): boolean {
  const nonNull = input.claims.filter(
    (claim): claim is ClaimReturn & { taskId: number } => claim.taskId !== null,
  );
  if (input.claims.length !== 2 || nonNull.length !== 2) return false;
  if (new Set(nonNull.map((claim) => claim.taskId)).size !== nonNull.length) return false;
  return (
    nonNull.filter(
      (claim) => claim.agent === input.competitorAgent && claim.taskId === input.raceTaskId,
    ).length === 1 &&
    nonNull.filter(
      (claim) => claim.agent === input.primaryAgent && claim.taskId === input.lifecycleTaskId,
    ).length === 1
  );
}
