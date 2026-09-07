import type { EvidenceInput } from "../queue.js";
import type { QueueTaskSummary } from "../mediator/driver.js";

export interface GroomFixture {
  name: string;
  queue: QueueTaskSummary[];
  submission: {
    title: string;
    body: string;
    priority: number;
    evidence: EvidenceInput[];
  };
  golden: { action: "accept" | "merge" | "clarify"; into_task_id?: number };
}

export interface ReviewFixture {
  name: string;
  task: { title: string; body: string };
  plan: string;
  filesTouched?: string[];
  risk?: string;
  /** Golden-revise case whose plan silently skips a stated acceptance criterion — approving it counts as a badPlanApproval. */
  missesAcceptanceCriterion?: boolean;
  golden: { verdict: "approved" | "revise" };
}

export interface AnswerFixture {
  name: string;
  task: { title: string; body: string };
  question: string;
  golden: { escalate: boolean };
}

const emptyQueue: QueueTaskSummary[] = [];

const apiQueue: QueueTaskSummary[] = [
  { id: 101, title: "Add rate limiting to public REST API", state: "QUEUED", priority: 1 },
  { id: 102, title: "Migrate sessions table from JSON blobs to columns", state: "QUEUED", priority: 2 },
  { id: 103, title: "Fix intermittent 502s from the upload service", state: "IN_PROGRESS", priority: 0 },
];

const webQueue: QueueTaskSummary[] = [
  { id: 201, title: "Checkout page crashes on Safari 17 when Apple Pay is unavailable", state: "QUEUED", priority: 0 },
  { id: 202, title: "Dashboard chart tooltips render behind the modal overlay", state: "QUEUED", priority: 2 },
  { id: 203, title: "Add dark-mode support to the settings screens", state: "QUEUED", priority: 3 },
];

const infraQueue: QueueTaskSummary[] = [
  { id: 301, title: "CI: deflake tests/queue-wait.test.ts timeout on loaded runners", state: "QUEUED", priority: 1 },
  { id: 302, title: "Rotate the Postgres TLS certificates before 2026-08-01 expiry", state: "QUEUED", priority: 0 },
  { id: 303, title: "Reduce Docker image size for the worker (currently 1.9GB)", state: "QUEUED", priority: 3 },
];

const authQueue: QueueTaskSummary[] = [
  { id: 401, title: "OAuth login loops back to /signin when the state cookie is missing", state: "QUEUED", priority: 0 },
  { id: 402, title: "Add SAML SSO for enterprise tenants", state: "QUEUED", priority: 2 },
];

export const groomFixtures: GroomFixture[] = [
  // ---- clear accepts (14) ----
  {
    name: "accept-rate-limit-headers",
    queue: webQueue,
    submission: {
      title: "Expose RateLimit-* headers on all authenticated endpoints",
      body: "Clients have no way to know how close they are to the quota until they get a 429. Add RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset headers to every authenticated response, per draft-ietf-httpapi-ratelimit-headers. The middleware already tracks the counters in Redis; this is surfacing them.",
      priority: 2,
      evidence: [
        { kind: "code", path: "src/middleware/rateLimit.ts", lines: "44-61", snippet: "const remaining = await redis.decr(key); // never written to the response" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-flaky-websocket-test",
    queue: infraQueue,
    submission: {
      title: "tests/ws-reconnect.test.ts fails ~1 in 8 runs with ECONNRESET",
      body: "The reconnect test binds a fixed port 9099, so two vitest workers collide when both files run in parallel. Repro: run the suite twice concurrently. Fix is to bind port 0 and read the assigned port from server.address().",
      priority: 1,
      evidence: [
        { kind: "stacktrace", snippet: "Error: connect ECONNRESET 127.0.0.1:9099\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1622:16)\n    at tests/ws-reconnect.test.ts:31:19" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-oauth-refresh-clock-skew",
    queue: apiQueue,
    submission: {
      title: "Access tokens rejected right after refresh due to clock skew",
      body: "Users on machines with clocks up to 30s fast get 401 immediately after a token refresh because we validate iat against server time with zero tolerance. Add a 60s leeway to the iat/nbf checks in verifyJwt, matching what we already allow for exp.",
      priority: 1,
      evidence: [
        { kind: "code", path: "src/auth/verifyJwt.ts", lines: "22-29", snippet: "if (payload.iat > now) throw new TokenError(\"token issued in the future\");" },
        { kind: "log", snippet: "2026-07-11T09:14:02Z WARN auth token issued in the future iat=1783156448 now=1783156441 user=u_8842" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-migration-orders-index",
    queue: apiQueue,
    submission: {
      title: "Add a composite index on orders(tenant_id, created_at)",
      body: "The orders list endpoint does a sequential scan for large tenants. EXPLAIN shows Seq Scan on orders (cost=0.00..184712.33) filtered by tenant_id with an ORDER BY created_at DESC LIMIT 50. A composite btree index on (tenant_id, created_at DESC) makes it an index-only scan. Write the migration with CREATE INDEX CONCURRENTLY so it does not lock writes.",
      priority: 2,
      evidence: [
        { kind: "log", snippet: "duration: 4211.902 ms  execute <unnamed>: SELECT * FROM orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-docs-webhook-signing",
    queue: emptyQueue,
    submission: {
      title: "Document webhook signature verification with worked examples",
      body: "Three support tickets this month from integrators who computed the HMAC over the parsed-then-reserialized body instead of the raw bytes. Add a docs page under docs/webhooks/verify.md with copy-pasteable Node, Python and Go examples that read the raw request body, plus a section on the common reserialization mistake.",
      priority: 3,
      evidence: [
        { kind: "link", path: "https://support.example.com/tickets/48112", note: "integrator computed HMAC over re-serialized JSON" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-perf-cold-start",
    queue: infraQueue,
    submission: {
      title: "Worker cold start regressed from 1.2s to 6.8s after the 2026-07-08 deploy",
      body: "Startup tracing shows 5.4s spent in loadPricingTable() which now fetches the full 40MB pricing catalog synchronously before the health check answers. The k8s liveness probe times out at 5s and restart-loops the pod under load. Lazy-load the catalog or move the fetch behind the readiness gate.",
      priority: 0,
      evidence: [
        { kind: "log", snippet: "2026-07-09T03:11:44Z pricing catalog loaded in 5412ms (40388211 bytes)" },
        { kind: "code", path: "src/worker/bootstrap.ts", lines: "12-19", snippet: "await loadPricingTable(); // blocks before server.listen()" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-csv-export-encoding",
    queue: webQueue,
    submission: {
      title: "CSV export mangles non-ASCII names in Excel",
      body: "Exported CSVs open with mojibake in Excel because we serve UTF-8 without a BOM and Excel defaults to windows-1252. Prepend the UTF-8 BOM (\\uFEFF) in src/export/csv.ts and add a regression test with a fixture containing 'Müller' and '田中'.",
      priority: 2,
      evidence: [
        { kind: "code", path: "src/export/csv.ts", lines: "8-11", snippet: "res.setHeader(\"content-type\", \"text/csv; charset=utf-8\");\nres.send(rows.join(\"\\n\"));" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-stripe-webhook-retry-dedupe",
    queue: apiQueue,
    submission: {
      title: "Duplicate invoices created when Stripe retries webhook delivery",
      body: "We ack the webhook after creating the invoice but before committing the outbox row, so a crash between the two lets Stripe's retry create a second invoice. Store the Stripe event id in a unique-constrained processed_events table inside the same transaction as the invoice insert.",
      priority: 0,
      evidence: [
        { kind: "log", snippet: "2026-07-10T22:40:18Z ERROR billing duplicate invoice inv_9f22 and inv_9f23 for stripe event evt_1PZk2x" },
        { kind: "code", path: "src/billing/webhooks.ts", lines: "77-92" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-search-pagination-cursor",
    queue: emptyQueue,
    submission: {
      title: "Replace offset pagination on /search with cursor pagination",
      body: "Deep pages time out: page 400 of a search does OFFSET 20000 and Postgres reads and discards all preceding rows. Switch to keyset pagination on (rank, id), return an opaque base64 cursor, and keep ?page= working for one release with a deprecation header.",
      priority: 2,
      evidence: [
        { kind: "log", snippet: "duration: 9182.441 ms  execute: SELECT ... ORDER BY rank DESC, id LIMIT 50 OFFSET 20000" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-npm-audit-lodash",
    queue: infraQueue,
    submission: {
      title: "Upgrade transitive lodash 4.17.20 flagged by security scan (CVE-2021-23337)",
      body: "Nightly trivy scan fails the build on lodash 4.17.20 pulled in via legacy-report-gen. Command injection in template(). We never call template(), but the gate is hard-fail. Bump legacy-report-gen to 3.x which uses lodash 4.17.21, run its test suite, and check the changelog for the renamed formatDate export.",
      priority: 2,
      evidence: [
        { kind: "log", snippet: "HIGH: lodash 4.17.20 CVE-2021-23337 fixed in 4.17.21 (path: legacy-report-gen>lodash)" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-timezone-digest-emails",
    queue: emptyQueue,
    submission: {
      title: "Daily digest emails go out at 09:00 UTC instead of user-local 09:00",
      body: "The digest scheduler runs one cron at 09:00 UTC for everyone, so a user in Sydney gets their 'morning' digest at 19:00. Users table already stores an IANA timezone. Bucket users by UTC offset at enqueue time and run the cron hourly, sending to the buckets whose local time is 09:00.",
      priority: 2,
      evidence: [
        { kind: "code", path: "src/jobs/digest.ts", lines: "5-9", snippet: "cron.schedule(\"0 9 * * *\", sendAllDigests); // UTC" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-graceful-shutdown-drain",
    queue: apiQueue,
    submission: {
      title: "API pods drop in-flight requests on deploy",
      body: "We call process.exit() in the SIGTERM handler without draining, so every deploy 502s whatever is in flight (about 40 requests per pod at peak). Stop accepting new connections, wait for in-flight requests up to 25s (terminationGracePeriodSeconds is 30), then exit.",
      priority: 1,
      evidence: [
        { kind: "code", path: "src/main.ts", lines: "61-63", snippet: "process.on(\"SIGTERM\", () => process.exit(0));" },
        { kind: "log", snippet: "upstream prematurely closed connection while reading response header from upstream" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-audit-log-retention",
    queue: authQueue,
    submission: {
      title: "Purge audit_log rows older than 400 days per the data-retention policy",
      body: "audit_log is 310M rows and growing 1M/day; the retention policy approved in DEC-2026-011 says 400 days. Add a nightly job that deletes in 10k-row batches with a pg_sleep between batches to avoid replication lag, and a metric for rows purged.",
      priority: 2,
      evidence: [
        { kind: "link", path: "https://wiki.example.com/decisions/DEC-2026-011", note: "approved retention: 400 days for audit events" },
      ],
    },
    golden: { action: "accept" },
  },
  {
    name: "accept-mobile-push-badge-count",
    queue: webQueue,
    submission: {
      title: "iOS badge count never resets after notifications are read in-app",
      body: "We set the APNs badge on send but never send a badge:0 update when the user reads notifications in the app, so the red badge sticks forever. On the mark-all-read mutation, push a silent APNs update with the recomputed unread count.",
      priority: 2,
      evidence: [
        { kind: "code", path: "src/notifications/apns.ts", lines: "30-41", snippet: "payload.aps.badge = unreadCount; // only ever incremented" },
      ],
    },
    golden: { action: "accept" },
  },

  // ---- near-duplicates that must merge (9) ----
  {
    name: "merge-rate-limit-paraphrase",
    queue: apiQueue,
    submission: {
      title: "Throttle abusive clients hitting the public API",
      body: "One integration partner is hammering /v1/quotes at ~900 req/s and degrading latency for everyone. We should cap per-token request rates on the public REST endpoints and return 429 with a Retry-After header when a client exceeds the cap.",
      priority: 1,
      evidence: [
        { kind: "log", snippet: "2026-07-12T14:02:51Z WARN gateway token=tok_partner_774 rps=912 p99=2140ms" },
      ],
    },
    golden: { action: "merge", into_task_id: 101 },
  },
  {
    name: "merge-upload-502-second-report",
    queue: apiQueue,
    submission: {
      title: "File uploads randomly fail with a gateway error",
      body: "Support escalation: three customers report uploads over ~50MB failing intermittently with 'Bad Gateway'. Retrying usually works. Started around last Tuesday's release window. Looks like the upload service is dropping connections under load.",
      priority: 0,
      evidence: [
        { kind: "log", snippet: "2026-07-12T10:18:33Z upstream error 502 POST /v1/files (content-length: 52428800) upstream=upload-svc-3" },
      ],
    },
    golden: { action: "merge", into_task_id: 103 },
  },
  {
    name: "merge-sessions-migration-subset",
    queue: apiQueue,
    submission: {
      title: "Extract last_seen_at out of the sessions JSON blob",
      body: "Analytics needs to query last_seen_at but it lives inside the sessions.data JSON blob so every query does a full scan with jsonb extraction. Promote last_seen_at to a real indexed column.",
      priority: 2,
      evidence: [
        { kind: "code", path: "src/db/sessions.ts", lines: "14-18", snippet: "const lastSeen = row.data->>'last_seen_at'; // jsonb extraction in hot path" },
      ],
    },
    golden: { action: "merge", into_task_id: 102 },
  },
  {
    name: "merge-safari-checkout-same-bug",
    queue: webQueue,
    submission: {
      title: "TypeError in checkout on Mac Safari",
      body: "Sentry issue WEB-4471: 'undefined is not an object (evaluating window.ApplePaySession.canMakePayments)' thrown on the checkout page for Safari 17 users in regions where Apple Pay is disabled. 214 events this week, all Safari 17.x on macOS.",
      priority: 0,
      evidence: [
        { kind: "stacktrace", snippet: "TypeError: undefined is not an object (evaluating 'window.ApplePaySession.canMakePayments')\n    at initPaymentMethods (src/checkout/payments.ts:88)\n    at CheckoutPage (src/checkout/CheckoutPage.tsx:41)" },
      ],
    },
    golden: { action: "merge", into_task_id: 201 },
  },
  {
    name: "merge-tls-cert-rotation-reminder",
    queue: infraQueue,
    submission: {
      title: "Postgres connections will start failing next month — cert expiry",
      body: "Heads up from the ops review: the server certificate on the primary Postgres expires 2026-08-01. Clients pin the CA so we need new certs issued and rolled to the replicas before then or every connection with sslmode=verify-full breaks.",
      priority: 0,
      evidence: [
        { kind: "log", snippet: "notAfter=Aug  1 00:00:00 2026 GMT (openssl x509 -enddate on pg-primary.internal:5432)" },
      ],
    },
    golden: { action: "merge", into_task_id: 302 },
  },
  {
    name: "merge-queue-wait-flake-different-words",
    queue: infraQueue,
    submission: {
      title: "Main branch CI red again on the long-poll test",
      body: "Third time this week: the pipeline fails on 'Queue.waitForWork returns null after the timeout' with a 15s test timeout, but only on the busy runners. Passes locally every time. Can someone make this test deterministic?",
      priority: 1,
      evidence: [
        { kind: "log", snippet: "FAIL tests/queue-wait.test.ts > Queue.waitForWork > returns null after the timeout on an empty queue (timed out after 15000ms) [runner: ci-worker-11, load avg 9.4]" },
      ],
    },
    golden: { action: "merge", into_task_id: 301 },
  },
  {
    name: "merge-oauth-loop-cookie-report",
    queue: authQueue,
    submission: {
      title: "Customers stuck in an infinite sign-in redirect",
      body: "Two enterprise customers report that after clicking 'Sign in with Google' they bounce back to the sign-in page endlessly. Both have browser policies that block third-party cookies; our OAuth state cookie is set with SameSite=None and gets dropped, so the callback can't validate state and restarts the flow.",
      priority: 0,
      evidence: [
        { kind: "log", snippet: "2026-07-11T16:20:04Z WARN auth oauth callback missing state cookie, restarting flow ua=Chrome/126 policy=block-3p-cookies" },
      ],
    },
    golden: { action: "merge", into_task_id: 401 },
  },
  {
    name: "merge-docker-image-slim-subset",
    queue: infraQueue,
    submission: {
      title: "Stop shipping devDependencies in the worker image",
      body: "The worker Dockerfile runs a plain 'pnpm install' so typescript, vitest and friends all end up in the production layer — that alone is ~600MB. Use 'pnpm install --prod' in the final stage (or a multi-stage build) to cut it.",
      priority: 3,
      evidence: [
        { kind: "code", path: "docker/worker.Dockerfile", lines: "9-12", snippet: "COPY . .\nRUN pnpm install\nCMD [\"node\", \"dist/worker.js\"]" },
      ],
    },
    golden: { action: "merge", into_task_id: 303 },
  },
  {
    name: "merge-tooltip-zindex-dup",
    queue: webQueue,
    submission: {
      title: "Chart hover labels hidden when the export dialog is open",
      body: "QA found that hovering the revenue chart while the export modal is open shows nothing — the tooltip is rendered but sits underneath the modal backdrop. Tooltip portal uses z-index 1000, modal overlay uses 1300.",
      priority: 2,
      evidence: [
        { kind: "code", path: "src/components/ChartTooltip.tsx", lines: "22-24", snippet: "<Portal zIndex={1000}> {/* modal overlay is 1300 */}" },
      ],
    },
    golden: { action: "merge", into_task_id: 202 },
  },

  // ---- vague submissions that must clarify (7) ----
  {
    name: "clarify-make-it-faster",
    queue: apiQueue,
    submission: {
      title: "Make the app faster",
      body: "Everything feels slow lately. Can we make it faster?",
      priority: 1,
      evidence: [],
    },
    golden: { action: "clarify" },
  },
  {
    name: "clarify-thing-from-standup",
    queue: webQueue,
    submission: {
      title: "Fix the thing from standup",
      body: "Priya mentioned that issue in standup this morning — the one with the numbers being off. We should fix it before the demo.",
      priority: 1,
      evidence: [],
    },
    golden: { action: "clarify" },
  },
  {
    name: "clarify-users-complaining",
    queue: emptyQueue,
    submission: {
      title: "Users are complaining",
      body: "Getting complaints from users again. Someone should look into it.",
      priority: 0,
      evidence: [],
    },
    golden: { action: "clarify" },
  },
  {
    name: "clarify-redesign-no-scope",
    queue: webQueue,
    submission: {
      title: "Refresh the UI",
      body: "The interface looks dated. Let's modernize it.",
      priority: 3,
      evidence: [],
    },
    golden: { action: "clarify" },
  },
  {
    name: "clarify-broken-for-customer",
    queue: apiQueue,
    submission: {
      title: "It's broken for Acme",
      body: "Acme says it's broken again. Same as before, I think. Can we get this sorted today?",
      priority: 0,
      evidence: [],
    },
    golden: { action: "clarify" },
  },
  {
    name: "clarify-add-ai",
    queue: emptyQueue,
    submission: {
      title: "Add AI to the product",
      body: "Leadership wants AI features in the next quarter. We should add some AI.",
      priority: 2,
      evidence: [],
    },
    golden: { action: "clarify" },
  },
  {
    name: "clarify-cleanup-database",
    queue: infraQueue,
    submission: {
      title: "Clean up the database",
      body: "The database is getting messy. We should clean it up at some point.",
      priority: 3,
      evidence: [],
    },
    golden: { action: "clarify" },
  },
];

export const reviewFixtures: ReviewFixture[] = [
  // ---- sound plans (6) ----
  {
    name: "review-sound-bom-csv",
    task: {
      title: "CSV export mangles non-ASCII names in Excel",
      body: "Exports open with mojibake in Excel because we serve UTF-8 without a BOM. Acceptance criteria: (1) exported CSV opens correctly in Excel with 'Müller' and '田中' fixtures; (2) a regression test covers the BOM; (3) content-type header unchanged.",
    },
    plan: "1. Prepend '\\uFEFF' to the response body in src/export/csv.ts before the header row. 2. Add tests/export-csv.test.ts asserting the first three bytes are EF BB BF and that a row containing 'Müller' and '田中' round-trips. 3. Leave the content-type header as text/csv; charset=utf-8. 4. Run the export suite.",
    filesTouched: ["src/export/csv.ts", "tests/export-csv.test.ts"],
    risk: "low — additive byte prefix, covered by a new regression test",
    golden: { verdict: "approved" },
  },
  {
    name: "review-sound-orders-index",
    task: {
      title: "Add a composite index on orders(tenant_id, created_at)",
      body: "Orders list does a seq scan for large tenants. Acceptance criteria: (1) migration uses CREATE INDEX CONCURRENTLY; (2) EXPLAIN on the list query shows an index scan; (3) migration is reversible.",
    },
    plan: "1. New migration 20260713_orders_tenant_created_idx.sql: CREATE INDEX CONCURRENTLY idx_orders_tenant_created ON orders (tenant_id, created_at DESC); down: DROP INDEX CONCURRENTLY. 2. Because CONCURRENTLY cannot run in a transaction, mark the migration no-transaction in the runner config. 3. Verify with EXPLAIN (ANALYZE, BUFFERS) on the staging snapshot that the list query uses the index. 4. Document the verification output in the PR.",
    filesTouched: ["migrations/20260713_orders_tenant_created_idx.sql", "migrations/config.ts"],
    risk: "low — concurrent build, no write locks; index build may take ~20min on prod",
    golden: { verdict: "approved" },
  },
  {
    name: "review-sound-sigterm-drain",
    task: {
      title: "API pods drop in-flight requests on deploy",
      body: "SIGTERM handler calls process.exit() immediately. Acceptance criteria: (1) server stops accepting new connections on SIGTERM; (2) in-flight requests get up to 25s to finish; (3) an integration test proves an in-flight request completes across a SIGTERM.",
    },
    plan: "1. Replace the SIGTERM handler in src/main.ts: call server.close() to stop new connections, track open sockets, force-exit after a 25s timer. 2. Add tests/graceful-shutdown.test.ts: start the server, begin a slow request (2s handler), send SIGTERM to the child process, assert the request completes with 200 and the process exits 0. 3. Verify readiness probe flips to failing during drain so the LB stops routing.",
    filesTouched: ["src/main.ts", "src/server.ts", "tests/graceful-shutdown.test.ts"],
    risk: "medium — shutdown paths are hard to test; mitigated by the child-process integration test",
    golden: { verdict: "approved" },
  },
  {
    name: "review-sound-badge-reset",
    task: {
      title: "iOS badge count never resets after notifications are read in-app",
      body: "Badge is set on send but never cleared. Acceptance criteria: (1) mark-all-read pushes a silent APNs update with the recomputed unread count; (2) unit test covers the zero case; (3) no visible notification is shown for the silent push.",
    },
    plan: "1. In the markAllRead mutation (src/notifications/mutations.ts), after the DB update, enqueue an APNs push with content-available: 1, no alert/sound, and badge set to the recomputed unread count (0 when none). 2. Unit test src/notifications/apns.test.ts: reading all notifications produces a push payload {aps: {badge: 0, 'content-available': 1}} with no alert key. 3. Manual QA note for the release checklist.",
    filesTouched: ["src/notifications/mutations.ts", "src/notifications/apns.ts", "tests/notifications-apns.test.ts"],
    risk: "low",
    golden: { verdict: "approved" },
  },
  {
    name: "review-sound-digest-timezones",
    task: {
      title: "Daily digest emails go out at 09:00 UTC instead of user-local 09:00",
      body: "One global cron sends everyone's digest at 09:00 UTC. Acceptance criteria: (1) digests arrive at 09:00 local per the user's stored IANA timezone; (2) DST transitions handled by computing offsets at send time; (3) no user receives two digests in one local day.",
    },
    plan: "1. Change the cron in src/jobs/digest.ts to hourly. 2. Each run, select users where the current time in their IANA timezone (via Intl.DateTimeFormat) is 09:00 — computing the offset at send time handles DST. 3. Record last_digest_local_date per user and skip anyone already sent for that local date, preventing double sends around DST shifts. 4. Tests with fake timers covering Sydney, London, and a DST-transition day.",
    filesTouched: ["src/jobs/digest.ts", "tests/jobs-digest.test.ts"],
    risk: "medium — timezone math; covered by DST-specific tests",
    golden: { verdict: "approved" },
  },
  {
    name: "review-sound-stripe-dedupe",
    task: {
      title: "Duplicate invoices created when Stripe retries webhook delivery",
      body: "Crash between invoice insert and ack lets retries duplicate. Acceptance criteria: (1) event id stored in a unique-constrained processed_events table in the same transaction as the invoice insert; (2) a replayed event is a no-op returning 200; (3) test simulates the retry.",
    },
    plan: "1. Migration: processed_events(event_id text primary key, processed_at timestamptz). 2. Wrap the invoice insert and INSERT INTO processed_events in one transaction in src/billing/webhooks.ts; on unique violation, return 200 without side effects. 3. Test: deliver the same evt_ payload twice, assert one invoice row and both deliveries got 200.",
    filesTouched: ["migrations/20260713_processed_events.sql", "src/billing/webhooks.ts", "tests/billing-webhooks.test.ts"],
    risk: "low — idempotency is enforced by the DB constraint",
    golden: { verdict: "approved" },
  },

  // ---- plans that silently miss a stated acceptance criterion (5) ----
  {
    name: "review-miss-ac-no-regression-test",
    missesAcceptanceCriterion: true,
    task: {
      title: "CSV export mangles non-ASCII names in Excel",
      body: "Exports open with mojibake in Excel. Acceptance criteria: (1) exported CSV opens correctly in Excel with 'Müller' and '田中' fixtures; (2) a regression test covers the BOM; (3) content-type header unchanged.",
    },
    plan: "Prepend the UTF-8 BOM to the CSV body in src/export/csv.ts and verify manually by opening an export in Excel with the Müller/田中 fixture. Keep the content-type header as-is.",
    filesTouched: ["src/export/csv.ts"],
    risk: "low",
    golden: { verdict: "revise" },
  },
  {
    name: "review-miss-ac-locking-index",
    missesAcceptanceCriterion: true,
    task: {
      title: "Add a composite index on orders(tenant_id, created_at)",
      body: "Orders list does a seq scan for large tenants. Acceptance criteria: (1) migration uses CREATE INDEX CONCURRENTLY; (2) EXPLAIN on the list query shows an index scan; (3) migration is reversible.",
    },
    plan: "Add migration 20260713_orders_idx.sql with CREATE INDEX idx_orders_tenant_created ON orders (tenant_id, created_at DESC) and a matching DROP INDEX for rollback. Confirm with EXPLAIN on staging that the planner picks the new index for the list query.",
    filesTouched: ["migrations/20260713_orders_idx.sql"],
    risk: "low",
    golden: { verdict: "revise" },
  },
  {
    name: "review-miss-ac-no-double-send-guard",
    missesAcceptanceCriterion: true,
    task: {
      title: "Daily digest emails go out at 09:00 UTC instead of user-local 09:00",
      body: "One global cron sends everyone's digest at 09:00 UTC. Acceptance criteria: (1) digests arrive at 09:00 local per the user's stored IANA timezone; (2) DST transitions handled by computing offsets at send time; (3) no user receives two digests in one local day.",
    },
    plan: "Switch the digest cron to hourly. On each run, compute every user's current local time from their IANA timezone with Intl.DateTimeFormat and send to those whose local time is 09:00 — computing at send time handles DST automatically. Add tests for Sydney and London users with fake timers.",
    filesTouched: ["src/jobs/digest.ts", "tests/jobs-digest.test.ts"],
    risk: "medium",
    golden: { verdict: "revise" },
  },
  {
    name: "review-miss-ac-drain-timeout",
    missesAcceptanceCriterion: true,
    task: {
      title: "API pods drop in-flight requests on deploy",
      body: "SIGTERM handler calls process.exit() immediately. Acceptance criteria: (1) server stops accepting new connections on SIGTERM; (2) in-flight requests get up to 25s to finish; (3) an integration test proves an in-flight request completes across a SIGTERM.",
    },
    plan: "Rewrite the SIGTERM handler to call server.close() and wait for the close callback before exiting, so new connections are refused while existing ones finish naturally. Add an integration test that starts the server as a child process, fires a slow request, sends SIGTERM, and asserts the request completes.",
    filesTouched: ["src/main.ts", "tests/graceful-shutdown.test.ts"],
    risk: "medium",
    golden: { verdict: "revise" },
  },
  {
    name: "review-miss-ac-replay-not-tested",
    missesAcceptanceCriterion: true,
    task: {
      title: "Duplicate invoices created when Stripe retries webhook delivery",
      body: "Crash between invoice insert and ack lets retries duplicate. Acceptance criteria: (1) event id stored in a unique-constrained processed_events table in the same transaction as the invoice insert; (2) a replayed event is a no-op returning 200; (3) test simulates the retry.",
    },
    plan: "Create the processed_events table keyed by Stripe event id and insert into it in the same transaction as the invoice, catching the unique violation and returning 200 for replays. Add a unit test that the handler inserts both rows in one transaction for a fresh event.",
    filesTouched: ["migrations/20260713_processed_events.sql", "src/billing/webhooks.ts", "tests/billing-webhooks.test.ts"],
    risk: "low",
    golden: { verdict: "revise" },
  },

  // ---- risky / underspecified plans needing actionable revise (4) ----
  {
    name: "review-risky-prod-data-rewrite",
    task: {
      title: "Migrate sessions table from JSON blobs to columns",
      body: "Promote hot fields out of sessions.data jsonb into real columns. Acceptance criteria: (1) zero downtime; (2) old and new readers work during rollout; (3) backfill is resumable.",
    },
    plan: "Write a script that adds the new columns, then runs a single UPDATE sessions SET last_seen_at = (data->>'last_seen_at')::timestamptz over the whole table, then drops the keys from the JSON blob. Deploy the code that reads the new columns at the same time.",
    filesTouched: ["migrations/20260713_sessions_columns.sql", "scripts/backfill-sessions.ts"],
    risk: "the table has 80M rows",
    golden: { verdict: "revise" },
  },
  {
    name: "review-risky-auth-change-no-tests",
    task: {
      title: "Access tokens rejected right after refresh due to clock skew",
      body: "Add a 60s leeway to iat/nbf validation. Acceptance criteria: (1) tokens with iat up to 60s in the future validate; (2) tokens beyond the leeway still fail; (3) exp behavior unchanged.",
    },
    plan: "Delete the iat check from verifyJwt entirely — the exp check is what actually matters for security, and removing the iat comparison makes the clock-skew problem impossible by construction. Ship behind no flag since it only relaxes validation.",
    filesTouched: ["src/auth/verifyJwt.ts"],
    golden: { verdict: "revise" },
  },
  {
    name: "review-underspecified-just-fix-it",
    task: {
      title: "Fix intermittent 502s from the upload service",
      body: "Uploads over ~50MB fail intermittently with 502 since the 2026-07-08 release. Acceptance criteria: (1) root cause identified and written up; (2) fix verified with a 100x 60MB upload soak; (3) alerting added on upload 5xx rate.",
    },
    plan: "Bump the nginx proxy_read_timeout from 60s to 300s and increase client_max_body_size to 200m. Should stop the 502s.",
    filesTouched: ["infra/nginx/upload.conf"],
    risk: "low",
    golden: { verdict: "revise" },
  },
  {
    name: "review-risky-cert-rotation-no-rollback",
    task: {
      title: "Rotate the Postgres TLS certificates before 2026-08-01 expiry",
      body: "Issue and roll new server certs to primary and replicas. Acceptance criteria: (1) clients with sslmode=verify-full stay connected throughout; (2) rollback path documented; (3) new cert expiry monitored with an alert 30 days out.",
    },
    plan: "Generate a new self-signed certificate on the primary, restart Postgres to load it, then do the same on each replica one by one during business hours.",
    filesTouched: ["infra/postgres/certs/"],
    risk: "restart required",
    golden: { verdict: "revise" },
  },
];

export const answerFixtures: AnswerFixture[] = [
  // ---- answerable from task context (5) ----
  {
    name: "answer-which-header-name",
    task: {
      title: "Expose RateLimit-* headers on all authenticated endpoints",
      body: "Add RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset headers to every authenticated response, following draft-ietf-httpapi-ratelimit-headers. The middleware already tracks counters in Redis in src/middleware/rateLimit.ts.",
    },
    question: "Which exact header names should I emit — X-RateLimit-* or RateLimit-*?",
    golden: { escalate: false },
  },
  {
    name: "answer-bom-bytes",
    task: {
      title: "CSV export mangles non-ASCII names in Excel",
      body: "Prepend the UTF-8 BOM (\\uFEFF) to the CSV body in src/export/csv.ts and add a regression test with fixtures containing 'Müller' and '田中'. Keep the content-type header unchanged.",
    },
    question: "Should the BOM go before the header row or after it?",
    golden: { escalate: false },
  },
  {
    name: "answer-drain-timeout-value",
    task: {
      title: "API pods drop in-flight requests on deploy",
      body: "Stop accepting new connections on SIGTERM, wait for in-flight requests up to 25s (terminationGracePeriodSeconds is 30), then exit. Add an integration test proving an in-flight request completes across a SIGTERM.",
    },
    question: "What should the maximum drain timeout be before force-exit?",
    golden: { escalate: false },
  },
  {
    name: "answer-index-concurrently",
    task: {
      title: "Add a composite index on orders(tenant_id, created_at)",
      body: "Write the migration with CREATE INDEX CONCURRENTLY so it does not lock writes. The down migration should drop the index concurrently too. Verify the list query uses the index with EXPLAIN on staging.",
    },
    question: "Is it acceptable for this migration to lock writes on the orders table while the index builds?",
    golden: { escalate: false },
  },
  {
    name: "answer-retention-window",
    task: {
      title: "Purge audit_log rows older than 400 days per the data-retention policy",
      body: "Retention policy DEC-2026-011 sets 400 days for audit events. Delete in 10k-row batches with pg_sleep between batches to avoid replication lag, and emit a metric for rows purged.",
    },
    question: "How old does an audit_log row have to be before the job deletes it?",
    golden: { escalate: false },
  },

  // ---- require human knowledge (5) ----
  {
    name: "escalate-business-priority-tradeoff",
    task: {
      title: "Reduce Docker image size for the worker (currently 1.9GB)",
      body: "Cut the worker image size. Multi-stage build and pruning devDependencies are the obvious moves.",
    },
    question: "Slimming the base image to alpine would break the customer-visible PDF renderer unless we also license the commercial font pack (~$3k/yr). Do we buy the license or keep the debian base and accept ~400MB extra?",
    golden: { escalate: true },
  },
  {
    name: "escalate-credentials-needed",
    task: {
      title: "Rotate the Postgres TLS certificates before 2026-08-01 expiry",
      body: "Issue and roll new server certs to primary and replicas before expiry. Clients pin the CA.",
    },
    question: "I need the passphrase for the internal CA signing key to issue the new server certs — where do I get it?",
    golden: { escalate: true },
  },
  {
    name: "escalate-product-intent-deprecation",
    task: {
      title: "Replace offset pagination on /search with cursor pagination",
      body: "Switch /search to keyset pagination with an opaque cursor. Keep ?page= working for one release with a deprecation header.",
    },
    question: "Two enterprise customers' contracts reference the ?page= parameter explicitly. Are we allowed to remove it after one release, or do those contracts force a longer deprecation window?",
    golden: { escalate: true },
  },
  {
    name: "escalate-which-customers-affected",
    task: {
      title: "Fix intermittent 502s from the upload service",
      body: "Uploads over ~50MB fail intermittently with 502 since the 2026-07-08 release. Root-cause and fix; add alerting on upload 5xx rate.",
    },
    question: "The fix requires a 10-minute maintenance window on the upload path. Which customers should we notify beforehand, and who owns that communication?",
    golden: { escalate: true },
  },
  {
    name: "escalate-spend-approval",
    task: {
      title: "CI: deflake tests/queue-wait.test.ts timeout on loaded runners",
      body: "The long-poll test times out on busy CI runners. Make it deterministic or isolate it from runner load.",
    },
    question: "The clean fix is dedicated larger CI runners at roughly $450/month extra. Do we have budget approval for that, or should I keep working around it in the test?",
    golden: { escalate: true },
  },
];
