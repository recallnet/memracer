/**
 * Format USD for analytics displays. Nonzero spend must never render as $0.00
 * (cheap models can be <$0.01 total and still matter for routing comparison).
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  // toFixed(2) rounds sub-cent totals to 0.00 — show a floor indicator instead.
  if (Number(abs.toFixed(2)) === 0) return `${sign}<$0.01`;
  return `${sign}$${abs.toFixed(2)}`;
}
