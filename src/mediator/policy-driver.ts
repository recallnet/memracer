import type {
  AnswerInput,
  AnswerResult,
  CompletionMeta,
  CompletionUsage,
  ConciliateInput,
  ConciliateResult,
  DiscussInput,
  DiscussResult,
  EnhanceInput,
  EnhanceResult,
  GroomResult,
  MediatorContext,
  MediatorDriver,
  ProjectKnowledgeRefreshInput,
  ProjectKnowledgeRefreshResult,
  ReviewInput,
  ReviewResult,
  Submission,
} from "./driver.js";
import type {
  JobPolicyInvocationFinish,
  JobPolicyInvocationKey,
  JobPolicyInvocationStart,
} from "./job-policy-log.js";
import {
  routeMediatorJob,
  selectRoutingArm,
  type GroomDifficultyClassifier,
  type MediatorRoute,
  type MediatorRoutingPolicy,
  type RoutingArm,
} from "./routing-policy.js";

export interface PolicyInvocationRecorder {
  start(input: JobPolicyInvocationStart): Promise<boolean>;
  finish(key: JobPolicyInvocationKey, result: JobPolicyInvocationFinish): Promise<boolean>;
}

export interface PolicyAwareDriverOptions {
  projectId: string;
  job: { id: number; kind: string; attempts: number };
  policy: MediatorRoutingPolicy;
  createDriver: (route: MediatorRoute, meter: (usage: CompletionUsage) => void) => MediatorDriver;
  prepareRoute?: (route: MediatorRoute) => MediatorRoute;
  classifier?: GroomDifficultyClassifier;
  recorder?: PolicyInvocationRecorder;
  now?: () => number;
}

function addUsage(total: CompletionUsage | undefined, usage: CompletionUsage): CompletionUsage {
  return {
    promptTokens: (total?.promptTokens ?? 0) + usage.promptTokens,
    completionTokens: (total?.completionTokens ?? 0) + usage.completionTokens,
    cachedTokens: (total?.cachedTokens ?? 0) + (usage.cachedTokens ?? 0),
    cacheWriteTokens: (total?.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    completionCount: (total?.completionCount ?? 0) + (usage.completionCount ?? 1),
    cacheReadByCompletion: [
      ...(total?.cacheReadByCompletion ?? []),
      ...(usage.cacheReadByCompletion ?? [usage.cachedTokens ?? 0]),
    ],
    requestedModel: usage.requestedModel ?? total?.requestedModel,
    resolvedModel: usage.resolvedModel ?? total?.resolvedModel,
    ...(
      total?.cacheDiscountUsd !== undefined || usage.cacheDiscountUsd !== undefined
        ? { cacheDiscountUsd: (total?.cacheDiscountUsd ?? 0) + (usage.cacheDiscountUsd ?? 0) }
        : {}
    ),
    ...(
      total?.costUsd !== undefined || usage.costUsd !== undefined
        ? { costUsd: (total?.costUsd ?? 0) + (usage.costUsd ?? 0) }
        : {}
    ),
  };
}

/** Applies one stable job policy while preserving the provider-neutral driver contract. */
export class PolicyAwareMediatorDriver implements MediatorDriver {
  private readonly arm: RoutingArm;
  private readonly now: () => number;
  private driver: MediatorDriver | undefined;
  private driverRoute: MediatorRoute | undefined;
  private invocation = 0;
  private invocationUsage: CompletionUsage | undefined;

  constructor(private readonly options: PolicyAwareDriverOptions) {
    this.arm = selectRoutingArm(options.policy, `${options.projectId}:${options.job.id}`);
    this.now = options.now ?? Date.now;
  }

  private getDriver(route: MediatorRoute): MediatorDriver {
    if (this.driver) {
      if (JSON.stringify(this.driverRoute) !== JSON.stringify(route)) {
        throw new Error("mediator policy changed within one durable job");
      }
      return this.driver;
    }
    this.driverRoute = route;
    this.driver = this.options.createDriver(route, (usage) => {
      this.invocationUsage = addUsage(this.invocationUsage, usage);
    });
    return this.driver;
  }

  private async invoke<T>(
    route: MediatorRoute,
    taskId: number | null,
    run: (driver: MediatorDriver) => Promise<T>,
    driverOverride?: MediatorDriver,
  ): Promise<T> {
    route = this.options.prepareRoute?.(route) ?? route;
    const invocation = ++this.invocation;
    const key = { jobId: this.options.job.id, attempt: this.options.job.attempts, invocation };
    const startedAt = this.now();
    this.invocationUsage = undefined;
    await this.options.recorder?.start({
      ...key,
      projectId: this.options.projectId,
      taskId,
      kind: this.options.job.kind,
      classifiedDifficulty: route.difficulty ?? null,
      model: route.model,
      effort: route.telemetryEffort ?? route.effort,
      maxTokens: route.telemetryMaxTokens ?? route.maxTokens,
      rolloutArm: this.arm,
      startedAt,
    });
    try {
      const result = await run(driverOverride ?? this.getDriver(route));
      await this.finish(key, "ok");
      return result;
    } catch (error) {
      await this.finish(key, "fail");
      throw error;
    }
  }

  private async finish(key: JobPolicyInvocationKey, outcome: "ok" | "fail"): Promise<void> {
    const usage = this.invocationUsage;
    try {
      await this.options.recorder?.finish(key, {
        outcome,
        finishedAt: this.now(),
        tokensIn: usage?.promptTokens ?? 0,
        tokensOut: usage?.completionTokens ?? 0,
      });
    } catch (error) {
      // A terminal telemetry write must never replay already-dispatched memory
      // tools. The worker/pipeline outcome remains authoritative and the
      // bounded diagnostic makes the missing finalization observable.
      console.error(`[job-policy-log-failure] ${JSON.stringify({
        ...key,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      })}`);
    }
  }

  private route(): MediatorRoute {
    return routeMediatorJob(this.options.policy, this.options.job.kind, this.arm);
  }

  async groom(ctx: MediatorContext, submission: Submission): Promise<GroomResult> {
    let difficulty: "simple" | "medium" | "hard" | undefined;
    if (
      this.options.job.kind === "groom" &&
      this.arm === "routed" &&
      this.options.policy.classifierEnabled
    ) {
      difficulty = this.options.classifier
        ? (await this.options.classifier.classify({
            title: submission.title,
            body: submission.body,
            evidence: submission.evidence,
            queue: ctx.queue,
          })).difficulty
        : "hard";
    }
    // A P0 is a precision task — never groom it below "hard" (xhigh), even if the
    // stochastic classifier under-rates it or never ran (difficulty undefined).
    // Under-grooming a P0 is catastrophic; extra effort is cheap.
    const order = { simple: 0, medium: 1, hard: 2 } as const;
    if (submission.priority === 0 && (difficulty === undefined || order[difficulty] < order.hard)) {
      difficulty = "hard";
    }
    const route = routeMediatorJob(this.options.policy, this.options.job.kind, this.arm, difficulty);
    return this.invoke(route, submission.taskId, (driver) => driver.groom(ctx, submission));
  }

  review(ctx: MediatorContext, input: ReviewInput): Promise<ReviewResult> {
    return this.invoke(this.route(), input.taskId, (driver) => driver.review(ctx, input));
  }

  answer(ctx: MediatorContext, input: AnswerInput): Promise<AnswerResult> {
    return this.invoke(this.route(), input.taskId > 0 ? input.taskId : null, (driver) => driver.answer(ctx, input));
  }

  discuss(ctx: MediatorContext, input: DiscussInput): Promise<DiscussResult> {
    return this.invoke(this.route(), null, (driver) => driver.discuss(ctx, input));
  }

  enhance(ctx: MediatorContext, input: EnhanceInput): Promise<EnhanceResult> {
    return this.invoke(this.route(), input.taskId, (driver) => driver.enhance(ctx, input));
  }

  conciliate(ctx: MediatorContext, input: ConciliateInput): Promise<ConciliateResult> {
    return this.invoke(this.route(), null, (driver) => driver.conciliate(ctx, input));
  }

  eligibility(input: { submission: string; brief: string }): Promise<{ serves_request: boolean; reason: string }> {
    // Eligibility is a small fresh-context faithfulness check — route it on the
    // cheap "answer" tier (low effort / cheap model), never the groom's xhigh
    // budget. It runs as its own sub-invocation on a dedicated cheap driver so
    // the durable job's primary route stays byte-stable (the single-route guard
    // in getDriver): the groom driver is untouched.
    const route = this.options.prepareRoute?.(routeMediatorJob(this.options.policy, "answer", this.arm))
      ?? routeMediatorJob(this.options.policy, "answer", this.arm);
    const driver = this.options.createDriver(route, (usage) => {
      this.invocationUsage = addUsage(this.invocationUsage, usage);
    });
    return this.invoke(route, null, (d) => d.eligibility(input), driver);
  }

  refreshProjectKnowledge(
    ctx: MediatorContext,
    input: ProjectKnowledgeRefreshInput,
  ): Promise<ProjectKnowledgeRefreshResult> {
    return this.invoke(this.route(), null, (driver) => {
      if (!driver.refreshProjectKnowledge) {
        throw new Error("configured mediator driver does not support project knowledge refresh");
      }
      return driver.refreshProjectKnowledge(ctx, input);
    });
  }

  takeMeta(): CompletionMeta | undefined {
    return this.driver?.takeMeta?.();
  }

  takeUsage(): CompletionUsage | undefined {
    return this.driver?.takeUsage?.();
  }
}
