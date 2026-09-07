import { describe, expect, it } from "vitest";
import { meaningfulSubmissionText, submissionContentIssue } from "../src/submission-content.js";

describe("submission content validation", () => {
  it.each(["", "   \n\t", "...", ". . .", "…", "……"])("rejects %j", (value) => {
    expect(meaningfulSubmissionText(value)).toBe(false);
  });

  it.each(["b", ".", "Fix upload retries", "Use … to show an omission"])("accepts terse real content %j", (value) => {
    expect(meaningfulSubmissionText(value)).toBe(true);
  });

  it("reports the first invalid field", () => {
    expect(submissionContentIssue("...", "real body")).toEqual({ field: "title", reason: "placeholder" });
    expect(submissionContentIssue("real title", " ")).toEqual({ field: "body", reason: "blank" });
  });
});
