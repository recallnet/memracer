import { jitteredRetryDelay, MAX_RETRY_MS } from "./retry.js";

export interface EventSourceLike {
  close(): void;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
}

export interface ProjectEventBridgeOptions {
  createEventSource?: (url: string) => EventSourceLike;
  invalidateProject(project: string): void | Promise<void>;
  reload(): void;
  probeProject?: (project: string) => Promise<"available" | "missing" | "unauthorized">;
  onProjectMissing?: (project: string) => void;
  onUnauthorized?: () => void;
  onStatus?: (status: "connecting" | "live" | "offline" | "reconnecting" | "unavailable") => void;
  debounceMs?: number;
  /** Hold "live" through brief SSE flaps; only surface reconnecting after this ms. Default 2500. */
  failureGraceMs?: number;
  random?: () => number;
  retryMs?: number;
}

export class ProjectEventBridge {
  private source: EventSourceLike | null = null;
  private project: string | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failureGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private version: string | null = null;
  private retryDelayMs: number;
  /** True after at least one successful open for the current project selection. */
  private everLive = false;

  constructor(private readonly options: ProjectEventBridgeOptions) {
    this.retryDelayMs = options.retryMs ?? 1_000;
  }

  setProject(project: string | null): void {
    this.disconnect();
    this.project = project;
    this.generation += 1;
    this.everLive = false;
    // Backoff belongs to one scoped stream. A newly selected project always
    // gets an immediate first retry instead of inheriting another tenant's delay.
    this.retryDelayMs = this.options.retryMs ?? 1_000;
    if (project) this.connect(project, this.generation);
  }

  close(): void {
    this.setProject(null);
  }

  private clearFailureGrace(): void {
    if (this.failureGraceTimer) clearTimeout(this.failureGraceTimer);
    this.failureGraceTimer = null;
  }

  private disconnect(): void {
    this.source?.close();
    this.source = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.clearFailureGrace();
    this.debounceTimer = null;
    this.retryTimer = null;
    this.options.onStatus?.("offline");
  }

  private connect(project: string, generation: number): void {
    if (project !== this.project || generation !== this.generation) return;
    // First open for this project: show connecting. Routine SSE reopens after
    // a flap stay on the last healthy status until failureGraceMs elapses.
    if (!this.everLive) this.options.onStatus?.("connecting");
    const create = this.options.createEventSource ?? ((url) => new EventSource(url) as EventSourceLike);
    const source = create(`/api/p/${encodeURIComponent(project)}/events`);
    this.source = source;
    source.onopen = () => {
      if (this.source === source && generation === this.generation) {
        this.retryDelayMs = this.options.retryMs ?? 1_000;
        this.everLive = true;
        this.clearFailureGrace();
        this.options.onStatus?.("live");
      }
    };
    source.addEventListener("changed", () => {
      if (this.source !== source || generation !== this.generation) return;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        if (project === this.project && generation === this.generation) void this.options.invalidateProject(project);
      }, this.options.debounceMs ?? 300);
    });
    source.addEventListener("version", (event) => {
      if (this.source !== source || generation !== this.generation) return;
      try {
        const next = (JSON.parse(event.data) as { version?: unknown }).version;
        if (typeof next !== "string") return;
        if (this.version && this.version !== next) this.options.reload();
        this.version = next;
      } catch { /* malformed version frames do not break the stream */ }
    });
    source.onerror = () => { void this.handleError(source, project, generation); };
  }

  private async handleError(source: EventSourceLike, project: string, generation: number): Promise<void> {
    if (this.source !== source || generation !== this.generation) return;
    source.close();
    this.source = null;
    let availability: "available" | "missing" | "unauthorized" = "available";
    try {
      availability = this.options.probeProject ? await this.options.probeProject(project) : "available";
    } catch {
      // A failed health probe is transport failure, not evidence that the
      // project disappeared. Retry the SSE connection through normal backoff.
      availability = "available";
    }
    if (project !== this.project || generation !== this.generation) return;
    if (availability === "missing") {
      this.clearFailureGrace();
      this.options.onStatus?.("unavailable");
      this.options.onProjectMissing?.(project);
      return;
    }
    if (availability === "unauthorized") {
      this.clearFailureGrace();
      this.options.onStatus?.("unavailable");
      this.options.onUnauthorized?.();
      return;
    }
    // Grace: keep UI on "Connected" through brief reconnect flaps.
    const grace = this.options.failureGraceMs ?? 2_500;
    if (this.everLive) {
      if (!this.failureGraceTimer) {
        this.failureGraceTimer = setTimeout(() => {
          this.failureGraceTimer = null;
          if (project === this.project && generation === this.generation && !this.source) {
            this.options.onStatus?.("reconnecting");
          }
        }, grace);
      }
    } else {
      this.options.onStatus?.("reconnecting");
    }
    const wait = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect(project, generation);
    }, jitteredRetryDelay(wait, this.options.random));
  }
}
