// Shared conservative recognition for mediator-authored goal task bodies.
// Exactly three ordered, non-empty structural lines are required so ordinary
// prose or malformed marker-like bodies cannot bypass the supervisor watchdog.
export function isGoalTaskBody(body) {
  if (typeof body !== "string") return false;
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  return (
    lines.length === 3 &&
    /^Goal:\s*\S/.test(lines[0]) &&
    /^Verify:\s*\S/.test(lines[1]) &&
    /^Invariants:\s*\S/.test(lines[2])
  );
}

export function isGoalTask(brief) {
  return isGoalTaskBody(brief?.body);
}
