import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction, Express } from "express";
import express from "express";
import type { Db } from "./db.js";
import type { Queue } from "./queue.js";
import type { MediatorWorker } from "./mediator/worker.js";
import {
  handleMergeProbeFailure,
  listAwaitingMerge,
  settleAwaitingMerge,
  type PrCheck,
  type PrVerifier,
  type PrVerification,
} from "./github-pr.js";
import { fileCiFixesForFailedSuite, isFailingConclusion } from "./github-ci-fix.js";

/**
 * Verify GitHub's X-Hub-Signature-256 over the raw request body.
 * Must run against the exact bytes GitHub signed — never re-serialized JSON.
 */
export function verifyGitHubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const supplied = Buffer.from(signatureHeader);
  const want = Buffer.from(expected);
  if (supplied.length !== want.length) return false;
  return timingSafeEqual(supplied, want);
}

export function githubWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.MEMRACER_GITHUB_WEBHOOK_SECRET?.trim();
  return secret || null;
}

interface PullRequestPayload {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    merged?: boolean;
    state?: string;
    html_url?: string;
    head?: { sha?: string; ref?: string };
  };
  repository?: { full_name?: string };
}

interface CheckSuitePayload {
  action?: string;
  check_suite?: {
    conclusion?: string | null;
    head_sha?: string;
    pull_requests?: Array<{ number: number }>;
  };
  repository?: { full_name?: string };
}

interface CheckRunPayload {
  action?: string;
  check_run?: {
    status?: string;
    conclusion?: string | null;
    head_sha?: string;
    pull_requests?: Array<{ number: number }>;
  };
  repository?: { full_name?: string };
}

export type WebhookHandleResult =
  | { status: "ignored"; reason: string }
  | { status: "settled"; outcomes: Array<"promoted" | "requeued" | "blocked" | "updated" | "noop"> };

/**
 * Event-driven merge-state for AWAITING_MERGE tasks. Primary path; PrMergePoller
 * is the 5-minute backstop only.
 */
export class GitHubWebhookHandler {
  constructor(
    private readonly db: Db,
    private readonly queue: Queue,
    private readonly worker: MediatorWorker,
    private readonly verifier: PrVerifier,
  ) {}

  async handle(event: string, payload: unknown): Promise<WebhookHandleResult> {
    if (event === "pull_request") return this.onPullRequest(payload as PullRequestPayload);
    if (event === "check_suite") return this.onCheckSuite(payload as CheckSuitePayload);
    if (event === "check_run") return this.onCheckRun(payload as CheckRunPayload);
    return { status: "ignored", reason: `unsupported event ${event}` };
  }

  private async onPullRequest(payload: PullRequestPayload): Promise<WebhookHandleResult> {
    if (payload.action !== "closed") {
      return { status: "ignored", reason: `pull_request.${payload.action ?? "unknown"}` };
    }
    const repo = payload.repository?.full_name;
    const prNumber = payload.pull_request?.number ?? payload.number;
    if (!repo || prNumber == null) {
      return { status: "ignored", reason: "missing repo or pr number" };
    }
    const rows = await listAwaitingMerge(this.db, { repo, prNumber });
    if (rows.length === 0) return { status: "ignored", reason: "no matching AWAITING_MERGE task" };

    const outcomes: Array<"promoted" | "requeued" | "blocked" | "updated" | "noop"> = [];
    for (const row of rows) {
      if (!row.repo) {
        outcomes.push("noop");
        continue;
      }
      // Prefer live verifier (same truth as poller). On transient failure, use
      // the webhook's closed/merged bits so a good delivery still moves state.
      let check: PrCheck;
      try {
        check = await this.verifier.check(row.repo, row.result_pr_number, row.pr_verification_etag);
      } catch {
        const merged = payload.pull_request?.merged === true;
        const head = payload.pull_request?.head;
        check = {
          state: (merged ? "merged-green" : "closed-unmerged") as PrVerification,
          etag: null,
          headSha: head?.sha,
          headRef: head?.ref,
        };
      }
      outcomes.push(await settleAwaitingMerge(this.db, this.queue, this.worker, row, check, this.verifier));
    }
    return { status: "settled", outcomes };
  }

  private async onCheckSuite(payload: CheckSuitePayload): Promise<WebhookHandleResult> {
    if (payload.action !== "completed") {
      return { status: "ignored", reason: `check_suite.${payload.action ?? "unknown"}` };
    }
    const repo = payload.repository?.full_name;
    if (!repo) return { status: "ignored", reason: "missing repo" };
    const prNumbers = (payload.check_suite?.pull_requests ?? []).map((pr) => pr.number);
    const settle = await this.reverifyRepo(repo, prNumbers);

    // Webhook-primary CI-fix: only failure-class conclusions, only open failing PRs.
    // Independent of settle — never blocks DONE promote on merge.
    if (isFailingConclusion(payload.check_suite?.conclusion)) {
      await fileCiFixesForFailedSuite(this.db, this.queue, this.verifier, {
        repo,
        prNumbers,
        conclusion: payload.check_suite?.conclusion,
        headSha: payload.check_suite?.head_sha,
      });
    }
    return settle;
  }

  private async onCheckRun(payload: CheckRunPayload): Promise<WebhookHandleResult> {
    if (payload.action !== "completed") {
      return { status: "ignored", reason: `check_run.${payload.action ?? "unknown"}` };
    }
    const repo = payload.repository?.full_name;
    if (!repo) return { status: "ignored", reason: "missing repo" };
    const prNumbers = (payload.check_run?.pull_requests ?? []).map((pr) => pr.number);
    return this.reverifyRepo(repo, prNumbers);
  }

  private async reverifyRepo(
    repo: string,
    prNumbers: number[],
  ): Promise<WebhookHandleResult> {
    const rows =
      prNumbers.length > 0
        ? (
            await Promise.all(prNumbers.map((n) => listAwaitingMerge(this.db, { repo, prNumber: n })))
          ).flat()
        : await listAwaitingMerge(this.db, { repo });
    if (rows.length === 0) return { status: "ignored", reason: "no matching AWAITING_MERGE task" };

    const outcomes: Array<"promoted" | "requeued" | "blocked" | "updated" | "noop"> = [];
    for (const row of rows) {
      if (!row.repo) {
        outcomes.push("noop");
        continue;
      }
      let check: PrCheck;
      try {
        check = await this.verifier.check(row.repo, row.result_pr_number, row.pr_verification_etag);
      } catch (err) {
        outcomes.push(await handleMergeProbeFailure(this.queue, row, err, "merge-webhook"));
        continue;
      }
      outcomes.push(await settleAwaitingMerge(this.db, this.queue, this.worker, row, check, this.verifier));
    }
    return { status: "settled", outcomes };
  }
}

/**
 * Mount POST /api/github/webhooks with raw-body HMAC verification.
 * Must be registered before express.json() so the body stays the signed bytes.
 */
export function registerGitHubWebhookRoutes(
  app: Express,
  opts: {
    secret: string | null;
    handler: GitHubWebhookHandler | null;
  },
): void {
  app.post(
    "/api/github/webhooks",
    express.raw({ type: "*/*", limit: "1mb" }),
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        if (!opts.secret || !opts.handler) {
          res.status(503).json({ error: "GitHub webhooks not configured" });
          return;
        }
        const raw = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(typeof req.body === "string" ? req.body : "");
        const signature = req.header("x-hub-signature-256") ?? undefined;
        if (!verifyGitHubWebhookSignature(raw, signature, opts.secret)) {
          res.status(401).json({ error: "invalid webhook signature" });
          return;
        }
        const event = req.header("x-github-event") ?? "";
        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          res.status(400).json({ error: "invalid JSON body" });
          return;
        }
        try {
          const result = await opts.handler.handle(event, payload);
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      })();
    },
  );
}
