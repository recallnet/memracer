export type SubmissionContentField = "title" | "body";

export interface SubmissionContentIssue {
  field: SubmissionContentField;
  reason: "blank" | "placeholder";
}

function contentReason(value: string): SubmissionContentIssue["reason"] | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "blank";
  const compact = trimmed.replace(/\s/gu, "");
  return /^(?:\.{3,}|…+)$/u.test(compact) ? "placeholder" : null;
}

export function submissionContentIssue(title: string, body: string): SubmissionContentIssue | null {
  const titleReason = contentReason(title);
  if (titleReason) return { field: "title", reason: titleReason };
  const bodyReason = contentReason(body);
  return bodyReason ? { field: "body", reason: bodyReason } : null;
}

export function meaningfulSubmissionText(value: string): boolean {
  return contentReason(value) === null;
}

export function submissionContentMessage(field: SubmissionContentField): string {
  return `${field} must describe the requested work; blank or ellipsis-only placeholders are not allowed`;
}
