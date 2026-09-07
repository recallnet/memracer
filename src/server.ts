import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toNodeHandler } from "better-auth/node";
import type { Db } from "./db.js";
import { requestSourceIp, resolveMember, type Member } from "./auth.js";
import { initAuth } from "./auth/instance.js";
import { mcpWwwAuthenticate, registerOAuthRoutes } from "./oauth.js";
import { cliInstallCommand } from "./cli-install.js";
import { Queue } from "./queue.js";
import { buildServer } from "./tools.js";
import { MediatorWorker, type JobRow } from "./mediator/worker.js";
import { registerPipelines } from "./mediator/pipelines.js";
import { registerDashboard, registerDashboardStatic } from "./dashboard.js";
import type { MediatorDriver } from "./mediator/driver.js";
import { oneLine } from "./mediator/question-ledger.js";
import {
  DbMcpEventStore,
  McpSessionStore,
  markTransportSessionInitialized,
  restoreClientCapabilities,
  type McpSessionRow,
} from "./mcp-session.js";
import {
  ImageAttachmentService,
  UnavailableImageBlobStore,
  type ImageBlobStore,
} from "./image-attachments.js";
import { makeMediatorRuntime, type MediatorRuntime } from "./mediator/effect-runtime.js";
import type { PrVerifier } from "./github-pr.js";
import {
  GitHubWebhookHandler,
  githubWebhookSecret,
  registerGitHubWebhookRoutes,
} from "./github-webhook.js";
import { isLegacyPublicHost, PRIMARY_PUBLIC_ORIGIN } from "./public-hosts.js";
import { registerStripeRoutes } from "./billing/http.js";
import { securityHeadersMiddleware } from "./security-headers.js";
import { AUTH_POST_LIMITER, MCP_401_LIMITER } from "./rate-limit.js";
import { startArchivePurgePoller } from "./project-archive.js";

export interface AppOptions {
  driverFor: (projectId: string, job?: JobRow) => MediatorDriver | Promise<MediatorDriver>;
  workerOpts?: { tickMs?: number; jobTimeoutMs?: number };
  /** SSE keepalive comment interval; the default survives a reverse proxy's idle timeout. */
  sseKeepaliveMs?: number;
  /** Public dashboard base URL (MEMRACER_PUBLIC_URL); enables shareable reference links in replies. */
  publicUrl?: string;
  /** Opaque image bytes; production injects R2 and tests inject an in-memory fake. */
  imageBlobStore?: ImageBlobStore;
  /** Shared production Effect runtime; tests may omit it for compatibility. */
  runtime?: MediatorRuntime;
  /** When set, coder_complete verifies PRs against GitHub (merged-green → DONE). */
  prVerifier?: PrVerifier | null;
  /** Override webhook secret (tests); defaults to MEMRACER_GITHUB_WEBHOOK_SECRET. */
  githubWebhookSecret?: string | null;
}

// A 10 MiB decoded image expands to just under 14 MiB as base64. Keep the
// larger parser confined to the authenticated MCP endpoint; dashboard/admin
// JSON retains Express's small default below.
export const MCP_JSON_LIMIT_BYTES = 15 * 1024 * 1024;

export function createApp(db: Db, options: AppOptions): { app: express.Express; queue: Queue; worker: MediatorWorker } {
  const ownsRuntime = options.runtime === undefined;
  const runtime = options.runtime ?? makeMediatorRuntime({ db });
  const queue = new Queue(db);
  const imageAttachments = new ImageAttachmentService(
    db,
    options.imageBlobStore ?? new UnavailableImageBlobStore(),
  );
  const consecutiveErrorThreshold = process.env.MEMRACER_CONSECUTIVE_ERROR_THRESHOLD
    ? Number(process.env.MEMRACER_CONSECUTIVE_ERROR_THRESHOLD)
    : undefined;
  const worker = new MediatorWorker(db, {
    ...options.workerOpts,
    runtime,
    ownsRuntime,
    consecutiveErrorThreshold,
    // A wedged orchestrator emits no queue mutations, so nudge every project's
    // dashboard to refetch health when a source escalates — otherwise the
    // degradation would sit unseen until unrelated queue activity fired.
    onEscalation: () => {
      void db
        .prepare("SELECT id FROM projects")
        .all<{ id: string }>()
        .then((rows) => {
          for (const row of rows) queue.notifyChanged(row.id);
        })
        .catch(() => undefined);
    },
  });
  // Liveness steward: retry/escalate stale groom; durable escalate alert when exhausted.
  const jobTimeoutMs = options.workerOpts?.jobTimeoutMs ?? 120_000;
  worker.registerSweep(async () => {
    const { runLivenessStewardPass } = await import("./mediator/liveness-steward.js");
    const projects = await db.prepare("SELECT id FROM projects").all<{ id: string }>();
    for (const row of projects) {
      await runLivenessStewardPass(db, worker, row.id, jobTimeoutMs);
    }
  });
  const app = express();
  app.use(securityHeadersMiddleware());

  // Optional browser HTML redirect legacy host → primary (API/MCP never redirected).
  // Enable with MEMRACER_CANONICAL_REDIRECT=1 once memracer.com DNS is green.
  app.use((req, res, next) => {
    if (process.env.MEMRACER_CANONICAL_REDIRECT !== "1") return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const host = req.get("host");
    if (!isLegacyPublicHost(host)) return next();
    const path = req.path || "/";
    if (path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/api/")) return next();
    const accept = req.get("accept") || "";
    if (!accept.includes("text/html") && path.startsWith("/")) {
      // Still redirect bare browser navigations without Accept when not API.
    }
    const dest = `${PRIMARY_PUBLIC_ORIGIN}${req.originalUrl || path}`;
    res.redirect(301, dest);
  });

  // better-auth sign-in / session / sign-up lives under /api/auth/*. Mounted
  // BEFORE express.json() so its handler reads the raw request body itself.
  // Disabled backends (PGlite) register no instance, so the route is absent.
  const authHandle = initAuth(db);
  if (authHandle) {
    registerOAuthRoutes(app, db, authHandle);
    app.all("/api/auth/*splat", (req, res, next) => {
      // Opt-in only: MEMRACER_AUTH_RATE_LIMIT=1. Default off so browser/CI
      // magic-link floods and local boots are not 429'd or wedged.
      if (
        process.env.MEMRACER_AUTH_RATE_LIMIT === "1"
        && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH")
      ) {
        const ip = requestSourceIp(req.headers, req.socket.remoteAddress) ?? "unknown";
        const limited = AUTH_POST_LIMITER.check(`auth:${ip}`);
        if (!limited.allowed) {
          res.setHeader("Retry-After", String(limited.retryAfterSec));
          res.status(429).json({ error: "too many auth requests; try again shortly" });
          return;
        }
      }
      next();
    }, toNodeHandler(authHandle.auth));
  }

  // Unauthenticated CLI bootstrap: `curl https://memracer.com/install.sh | sh`.
  // Served before the /mcp auth guard so a fresh teammate can install without a
  // seat key. The install command tracks the active release channel
  // (a tarball on this repository's `cli-latest` release via `gh`, or npm).
  app.get("/install.sh", (_req, res) => {
    res.setHeader("Content-Type", "text/x-shellscript; charset=utf-8");
    res.send(
      [
        "#!/bin/sh",
        "set -e",
        cliInstallCommand(process.env),
        'echo "memracer installed. Run: memracer enroll <token>"',
        "",
      ].join("\n"),
    );
  });

  const mcpSessionStore = new McpSessionStore(db);
  type LiveMcpSession = {
    sessionId: string;
    keyId: string;
    member: Member;
    server: ReturnType<typeof buildServer>;
    transport: StreamableHTTPServerTransport;
    streamReady: boolean;
  };
  const mcpSessions = new Map<string, LiveMcpSession>();
  /** Single-flight rehydrate promises so concurrent cache-misses share one rebuild. */
  const rehydrating = new Map<string, Promise<LiveMcpSession | null>>();
  /** False after worker stop — refuse rehydrate so shutdown is not blocked by new SSE streams. */
  let acceptingSessionRehydrate = true;
  const deliveringKeys = new Map<string, string>();

  const loadIncubations = async (member: Member) => {
    const humanProjectIds = member.memberships
      .filter((m) => m.role === "human" || m.role === "admin")
      .map((m) => m.projectId);
    if (humanProjectIds.length === 0) return [];
    return db
      .prepare(
        `SELECT id, title, project_id AS "projectId" FROM tasks
         WHERE state='INCUBATING' AND project_id IN (${humanProjectIds.map(() => "?").join(",")})
         ORDER BY incubate_until ASC, id ASC`,
      )
      .all<{ id: number; title: string; projectId: string }>(...humanProjectIds);
  };

  /**
   * Rebuild process-local transport+server for a durable session after restart.
   * Caller must have confirmed durable is active for keyId and map miss.
   */
  const rehydrateSession = async (
    durable: McpSessionRow,
    keyId: string,
    member: Member,
  ): Promise<LiveMcpSession | null> => {
    const sessionId = durable.id;
    const existing = mcpSessions.get(sessionId);
    if (existing) return existing.keyId === keyId ? existing : null;

    const incubations = await loadIncubations(member);
    const server = buildServer(
      queue,
      member,
      worker,
      db,
      incubations,
      options.publicUrl,
      imageAttachments,
      options.prVerifier,
    );
    restoreClientCapabilities(
      server.server as unknown as { _clientCapabilities?: unknown },
      durable.capabilities,
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      eventStore: new DbMcpEventStore(db, sessionId),
      onsessioninitialized: () => {
        mcpSessions.set(sessionId, { sessionId, keyId, member, server, transport, streamReady: false });
      },
      onsessionclosed: async () => {
        mcpSessions.delete(sessionId);
        deliveringKeys.forEach((deliveringSessionId, key) => {
          if (deliveringSessionId === sessionId) deliveringKeys.delete(key);
        });
        await mcpSessionStore.close(sessionId, keyId);
      },
    });
    markTransportSessionInitialized(transport, sessionId);
    await server.connect(transport);
    const live: LiveMcpSession = {
      sessionId,
      keyId,
      member,
      server,
      transport,
      streamReady: false,
    };
    // Race: another request may have won single-flight and already set the map.
    const raced = mcpSessions.get(sessionId);
    if (raced) {
      await server.close().catch(() => undefined);
      return raced.keyId === keyId ? raced : null;
    }
    mcpSessions.set(sessionId, live);
    return live;
  };

  const ensureLiveSession = async (
    sessionId: string,
    keyId: string,
    member: Member,
  ): Promise<LiveMcpSession | null> => {
    // Durable row is authoritative: closed/expired sessions must not be served
    // from a stale process-local entry (e.g. DELETE on another replica).
    const durable = await mcpSessionStore.active(sessionId, keyId);
    if (!durable) {
      const stale = mcpSessions.get(sessionId);
      // Only drop process-local state when THIS key's durable row is gone.
      // A foreign key's miss must not destroy another seat's live session.
      if (stale && stale.keyId === keyId) {
        mcpSessions.delete(sessionId);
        void stale.server.close().catch((error) => {
          console.error("[mcp-session-close-failure]", error instanceof Error ? error.message : String(error));
        });
      }
      return null;
    }

    const existing = mcpSessions.get(sessionId);
    if (existing) return existing.keyId === keyId ? existing : null;

    // Do not rebuild transports during shutdown — that opens SSE streams that
    // block process exit / httpServer.close while durable rows still exist.
    if (!acceptingSessionRehydrate) return null;

    // Single-flight: set the promise before any await so concurrent misses share one rebuild.
    let pending = rehydrating.get(sessionId);
    if (!pending) {
      pending = (async () => {
        if (!acceptingSessionRehydrate) return null;
        const again = mcpSessions.get(sessionId);
        if (again) return again.keyId === keyId ? again : null;
        // Re-check durable inside the flight in case it closed mid-wait.
        const still = await mcpSessionStore.active(sessionId, keyId);
        if (!still || !acceptingSessionRehydrate) return null;
        return rehydrateSession(still, keyId, member);
      })().finally(() => {
        rehydrating.delete(sessionId);
      });
      rehydrating.set(sessionId, pending);
    }
    return pending;
  };
  const dispatchClarification = async (input: {
    projectId: string;
    taskId: number;
    questionId: number;
    question: string;
    submittedBy: string;
    negotiationId?: string;
  }): Promise<void> => {
    const { projectId, taskId, questionId, question, submittedBy, negotiationId } = input;
    const { NegotiationStore } = await import("./negotiation.js");
    const neg = negotiationId
      ? await new NegotiationStore(db).get(negotiationId)
      : await new NegotiationStore(db).openForSubject(taskId);
    const wantRole = neg?.party_role ?? "human";
    const target = [...mcpSessions.values()].reverse().find((session) =>
      session.member.name === submittedBy &&
      session.streamReady &&
      session.member.memberships.some((membership) =>
        membership.projectId === projectId &&
        (wantRole === "coder"
          ? (membership.role === "coder" || membership.role === "admin")
          : (membership.role === "human" || membership.role === "admin"))) &&
      session.server.server.getClientCapabilities()?.elicitation != null,
    );
    const deliveryKey = neg ? `neg:${neg.id}` : `q:${questionId}`;
    if (!target || deliveringKeys.get(deliveryKey) === target.sessionId) return;
    deliveringKeys.set(deliveryKey, target.sessionId);
    try {
      const result = await target.server.server.elicitInput({
        mode: "form",
        message: question,
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string", title: "Answer" } },
          required: ["answer"],
        },
      }, { timeout: 120_000 });
      const answer = result.action === "accept" && typeof result.content?.answer === "string"
        ? result.content.answer.trim()
        : "";
      if (!answer) return;
      if (neg && (neg.state === "awaiting_party" || neg.state === "awaiting_person")) {
        await new NegotiationStore(db).answer(neg.id, submittedBy, answer);
        if (neg.party_role === "coder") {
          const brief = await queue.brief(taskId);
          // Parity with coder_answer: never enqueue review without a stored plan.
          if (!brief.plan) return;
          await worker.enqueue(projectId, "review", {
            taskId,
            plan: brief.plan,
            agent: submittedBy,
            priorAnswer: answer,
          });
        } else {
          // Close the legacy questions row. Prefer the durable question_id
          // stored on the negotiation (#473); reconnect re-dispatches with
          // questionId:0 so the live id is often useless. Fall back to
          // oneLine text match only for pre-link negotiation rows.
          let openRow =
            questionId > 0 ? await queue.questionById(questionId) : null;
          if ((!openRow || openRow.status !== "open" || openRow.task_id !== taskId) &&
              neg.question_id != null) {
            openRow = await queue.questionById(neg.question_id);
          }
          if (!openRow || openRow.status !== "open" || openRow.task_id !== taskId) {
            const promptKey = oneLine(question);
            const openRows = await db
              .prepare(
                `SELECT id, project_id, task_id, asked_by, status, question, domain, refresh_trigger
                 FROM questions
                 WHERE task_id = ? AND asked_by = 'mediator' AND status = 'open'
                 ORDER BY id DESC`,
              )
              .all<{
                id: number;
                project_id: string;
                task_id: number | null;
                asked_by: string;
                status: string;
                question: string;
                domain: string | null;
                refresh_trigger: string | null;
              }>(neg.subject_task_id);
            openRow = openRows.find((row) => oneLine(row.question) === promptKey) ?? null;
          }
          if (openRow && openRow.status === "open" && openRow.task_id === taskId) {
            await queue.answerQuestion(openRow.id, answer, submittedBy);
          }
          const brief = await queue.brief(taskId);
          await worker.enqueue(projectId, "groom", { taskId, submittedBy: brief.submitted_by });
        }
        return;
      }
      const current = await queue.questionById(questionId);
      if (!current || current.status !== "open" || current.task_id !== taskId) return;
      await queue.answerQuestion(questionId, answer, submittedBy);
      const brief = await queue.brief(taskId);
      await worker.enqueue(projectId, "groom", { taskId, submittedBy: brief.submitted_by });
    } catch {
      // The durable open question / negotiation remains the fallback after
      // disconnect, timeout, decline, or a client without elicitation.
    } finally {
      if (deliveringKeys.get(deliveryKey) === target.sessionId) deliveringKeys.delete(deliveryKey);
    }
  };
  const dispatchOpenClarifications = async (member: Member): Promise<void> => {
    const openClarifications = await db.prepare(
      `SELECT q.id AS question_id, q.task_id, q.question, q.project_id, t.submitted_by
       FROM questions q JOIN tasks t ON t.id=q.task_id
       WHERE q.status='open' AND q.asked_by='mediator' AND t.submitted_by=?`,
    ).all<{ question_id: number; task_id: number; question: string; project_id: string; submitted_by: string }>(member.name);
    for (const open of openClarifications) {
      void dispatchClarification({
        projectId: open.project_id,
        taskId: open.task_id,
        questionId: open.question_id,
        question: open.question,
        submittedBy: open.submitted_by,
      });
    }
    const openNegs = await db.prepare(
      `SELECT id, project_id, subject_task_id, current_prompt, party_identity
       FROM negotiations
       WHERE party_identity = ? AND state IN ('awaiting_party','awaiting_person')
         AND current_prompt IS NOT NULL`,
    ).all<{
      id: string;
      project_id: string;
      subject_task_id: number;
      current_prompt: string;
      party_identity: string;
    }>(member.name);
    for (const n of openNegs) {
      void dispatchClarification({
        projectId: n.project_id,
        taskId: n.subject_task_id,
        questionId: 0,
        question: n.current_prompt,
        submittedBy: n.party_identity,
        negotiationId: n.id,
      });
    }
  };

  registerPipelines({
    db,
    queue,
    worker,
    driverFor: options.driverFor,
    publicUrl: options.publicUrl,
    onClarification: dispatchClarification,
  });
  worker.onStop(() => {
    acceptingSessionRehydrate = false;
    const sessions = [...mcpSessions.values()];
    mcpSessions.clear();
    rehydrating.clear();
    deliveringKeys.clear();
    for (const session of sessions) {
      void session.server.close().catch((error) => {
        console.error("[mcp-session-close-failure]", error instanceof Error ? error.message : String(error));
      });
    }
  });
  worker.start();
  const archivePurge = startArchivePurgePoller(db);
  worker.onStop(() => archivePurge.stop());

  const authenticateMcp = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const ip = requestSourceIp(req.headers, req.socket.remoteAddress) ?? "unknown";
    const member = await resolveMember(db, req.headers.authorization, {
      sourceIp: ip,
    });
    if (!member) {
      const limited = MCP_401_LIMITER.check(`mcp401:${ip}`);
      if (!limited.allowed) {
        res.setHeader("Retry-After", String(limited.retryAfterSec));
        res.status(429).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "too many unauthorized requests" },
          id: null,
        });
        return;
      }
      res.setHeader("WWW-Authenticate", mcpWwwAuthenticate());
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "unauthorized" },
        id: null,
      });
      return;
    }
    res.locals.member = member;
    next();
  };

  app.all(
    "/mcp",
    authenticateMcp,
    express.json({ limit: MCP_JSON_LIMIT_BYTES }),
    async (req, res) => {
      const member = res.locals.member as Member;
      const keyId = member.keyId;
      if (!keyId) {
        res.setHeader("WWW-Authenticate", mcpWwwAuthenticate());
        res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
        return;
      }
      const header = req.get("mcp-session-id");
      if (header) {
        // Durable session + process-local miss → rehydrate after redeploy.
        // Requires an active durable row bound to this key; never invents sessions.
        const active = await ensureLiveSession(header, keyId, member);
        if (!active) {
          res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "session not found" }, id: null });
          return;
        }
        await mcpSessionStore.touch(header, keyId);
        const handling = active.transport.handleRequest(req, res, req.body);
        if (req.method === "GET") {
          let closed = false;
          setImmediate(() => {
            if (closed || mcpSessions.get(header) !== active) return;
            active.streamReady = true;
            void dispatchOpenClarifications(active.member).catch((error) => {
              console.error("[clarification-redispatch-failure]", error instanceof Error ? error.message : String(error));
            });
          });
          res.on("close", () => {
            closed = true;
            if (mcpSessions.get(header) === active) active.streamReady = false;
          });
        }
        await handling;
        if (req.method === "DELETE") {
          mcpSessions.delete(header);
          await mcpSessionStore.close(header, keyId);
          await active.server.close();
        }
        return;
      }
      if (req.method !== "POST") {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Mcp-Session-Id header is required" }, id: null });
        return;
      }
      const initializing = req.body?.method === "initialize";
      // Onboarding hook (#62): surface warming tasks this human could join, read
      // once at connect time and folded into the server instructions.
      const incubations = await loadIncubations(member);
      const server = buildServer(
        queue,
        member,
        worker,
        db,
        incubations,
        options.publicUrl,
        imageAttachments,
        options.prVerifier,
      );
      if (!initializing) {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      const sessionId = randomUUID();
      server.server.oninitialized = () => {
        void mcpSessionStore.setCapabilities(sessionId, keyId, server.server.getClientCapabilities())
          .catch((error) => {
            console.error("[session-capabilities-failure]", error instanceof Error ? error.message : String(error));
          });
      };
      for (const [id, active] of mcpSessions) {
        if (await mcpSessionStore.active(id, active.keyId)) continue;
        mcpSessions.delete(id);
        await active.server.close();
      }
      await mcpSessionStore.cleanup();
      await mcpSessionStore.create({
        id: sessionId,
        keyId,
        memberName: member.name,
        projectIds: member.memberships.map((membership) => membership.projectId),
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        eventStore: new DbMcpEventStore(db, sessionId),
        onsessioninitialized: () => {
          mcpSessions.set(sessionId, { sessionId, keyId, member, server, transport, streamReady: false });
        },
        onsessionclosed: async () => {
          mcpSessions.delete(sessionId);
          deliveringKeys.forEach((deliveringSessionId, key) => {
            if (deliveringSessionId === sessionId) deliveringKeys.delete(key);
          });
          await mcpSessionStore.close(sessionId, keyId);
        },
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  // GitHub App webhooks need the raw signed body — mount before express.json().
  const webhookSecret =
    options.githubWebhookSecret !== undefined
      ? options.githubWebhookSecret
      : githubWebhookSecret();
  const webhookHandler =
    options.prVerifier && webhookSecret
      ? new GitHubWebhookHandler(db, queue, worker, options.prVerifier)
      : null;
  registerGitHubWebhookRoutes(app, { secret: webhookSecret, handler: webhookHandler });

  // Stripe webhooks need the raw signed body — mount before express.json().
  registerStripeRoutes(app, db);

  // All non-MCP JSON keeps the framework default request limit.
  app.use(express.json());

  registerDashboard(app, db, queue, {
    sseKeepaliveMs: options.sseKeepaliveMs,
    worker,
    imageAttachments,
  });
  registerDashboardStatic(app);

  app.use(((error, _req, res, _next) => {
    console.error("[http-request-failure]", error instanceof Error ? error.message : String(error));
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({ error: "internal server error" });
  }) satisfies express.ErrorRequestHandler);

  return { app, queue, worker };
}
