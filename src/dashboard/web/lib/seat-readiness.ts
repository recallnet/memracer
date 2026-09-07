/** Seat readiness from minted MCP API keys (type human|coder), not dashboard login. */

export type SeatKeyLike = { type?: string | null };

/** Project-wide factory readiness (no secrets) — from GET /api/p/:project/seat-readiness. */
export type ProjectSeatReadiness = {
  factoryReady: boolean;
  humanSeats: number;
  coderSeats: number;
  hasTaskHistory: boolean;
  /** Org has an active paid plan — Frigg only grooms submissions when true. */
  friggReady: boolean;
};

export function hasHumanSeat(keys: readonly SeatKeyLike[] | null | undefined): boolean {
  return (keys ?? []).some((key) => key.type === "human");
}

export function hasCoderSeat(keys: readonly SeatKeyLike[] | null | undefined): boolean {
  return (keys ?? []).some((key) => key.type === "coder");
}

/** Viewer-oriented: factory ready when the given key list has ≥1 human and ≥1 coder. */
export function isFactoryReady(keys: readonly SeatKeyLike[] | null | undefined): boolean {
  return hasHumanSeat(keys) && hasCoderSeat(keys);
}

export type SeatReadinessState = "empty" | "partial" | "ready";

export function seatReadinessState(keys: readonly SeatKeyLike[] | null | undefined): SeatReadinessState {
  const human = hasHumanSeat(keys);
  const coder = hasCoderSeat(keys);
  if (!human && !coder) return "empty";
  if (human && coder) return "ready";
  return "partial";
}

export function getStartedStorageKey(projectId: string): string {
  return `memracer.get-started.dismissed.${projectId}`;
}

export function isGetStartedDismissed(projectId: string, storage: Pick<Storage, "getItem"> | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(getStartedStorageKey(projectId)) === "1";
  } catch {
    return false;
  }
}

export function dismissGetStarted(projectId: string, storage: Pick<Storage, "setItem"> | null): void {
  if (!storage) return;
  try {
    storage.setItem(getStartedStorageKey(projectId), "1");
  } catch {
    /* ignore quota / private mode */
  }
}

/** Which onboarding message the panel shows: teach seats, or gate on billing. */
export type GetStartedMode = "seats" | "billing";

/**
 * Seats are connected (factory ready) but the org has no active plan, so Frigg
 * will not groom yet — show the billing gate instead of the seat teaching.
 */
export function getStartedMode(readiness: ProjectSeatReadiness): GetStartedMode {
  return readiness.factoryReady && !readiness.friggReady ? "billing" : "seats";
}

/**
 * Operations Get started: hide while readiness is unknown/loading or when the
 * viewer dismissed the panel. The terminal "all set" state requires BOTH seat
 * types connected AND an active plan (friggReady) — until then keep teaching:
 * seat setup first, then the billing gate once seats connect.
 */
export function shouldShowGetStarted(
  projectId: string,
  readiness: ProjectSeatReadiness | null | undefined,
  storage: Pick<Storage, "getItem"> | null,
): boolean {
  if (readiness == null) return false;
  if (readiness.factoryReady && readiness.friggReady) return false;
  if (isGetStartedDismissed(projectId, storage)) return false;
  return true;
}
