# Effect boundaries

Effect owns memracer's long-lived concurrent lifecycle. Promise remains the
public integration boundary for domain code and external libraries.

## Use Effect for

- worker supervision, child fibers, interruption, and scoped finalizers;
- timeout and retry policies whose cancellation must release resources;
- shared runtime services supplied through Layers; and
- resources whose creator has an explicit disposal obligation.

## Keep Promise for

- the public `MediatorDriver` interface;
- database transactions and Queue domain operations;
- Express and MCP SDK handlers; and
- one-shot library calls that have no owned concurrent lifecycle.

Cross the boundary once at an owning edge with `effectPromiseRunner` or
`runEffectPromise`. Do not create a runtime per operation or wrap every SQL
transaction in a separate Effect. Inject the application `ManagedRuntime` into
the worker and drivers; only the code that creates a runtime disposes it, after
its worker scopes have stopped.

The mediator worker is the positive case: one root scope supervises periodic
work and bounded scheduling/execution `FiberSet`s. Only the execution set
contributes to public in-flight status; null and blocked claim attempts remain
scheduling details. `acquireRelease` protects claimed jobs, and handler timeout
interruption returns the slot even if the underlying Promise never settles.
After a claim returns, the worker checks the stop state again before starting
its handler; a claim that crossed `stop()` is returned by the same exact-claim
finalizer. Every release observes a one-shot deadline signal even before
`stopAndWait` arms it, so an already-blocked requeue is still bounded. Forced
process shutdown reserves bounded tails for claim persistence and outer
runtime/DB cleanup, interrupts
and awaits the executing child, then gives that guarded requeue write only the
time remaining before the worker deadline. A slow database Promise may continue
below the Effect boundary; the lazy watchdog recovers a still-running claim on
the next worker. Active HTTP responses share the shutdown deadline and are
force-closed before runtime and database cleanup begins. The outer shutdown
reserves up to 250 ms after the HTTP/worker drain, stops awaiting runtime and DB
cleanup at the same absolute deadline, records
the timeout, and the production signal handler explicitly exits after the
bounded result; this prevents an uncancellable driver handle from pinning the
process without claiming that its underlying Promise was cancelled. Promise
handlers and SQL transactions remain at explicit edges.

`queue.ts` is not the next migration target. It is already a transactional
Promise/DB domain service and does not own long-lived fibers, handler deadlines,
or cancellation-sensitive resources. Migrating it now would add boundary
bridges without a measured reliability benefit.

Run `pnpm eval:effect-adoption --quality` to reproduce the current source
measurements and deterministic quality gates. The committed scorecard is
`src/eval/effect-worker-scorecard.ts`.
