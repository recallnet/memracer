import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectEventBridge, type EventSourceLike } from "../src/dashboard/web/data/project-events.js";
import { jitteredRetryDelay } from "../src/dashboard/web/data/retry.js";

class FakeSource implements EventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  close() { this.closed = true; }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
  emit(type: string, data = "") { this.listeners.get(type)?.({ data } as MessageEvent<string>); }
}

afterEach(() => vi.useRealTimers());

describe("project SSE bridge", () => {
  const stableJitter = { random: () => 0.5 };

  it("jitters retry delays within bounds and caps the result at 30s", () => {
    expect(jitteredRetryDelay(1_000, () => 0)).toBe(800);
    expect(jitteredRetryDelay(1_000, () => 0.5)).toBe(1_000);
    expect(jitteredRetryDelay(1_000, () => 1)).toBe(1_200);
    expect(jitteredRetryDelay(30_000, () => 1)).toBe(30_000);
  });

  it("debounces changed frames for 300ms and drops stale project work", async () => {
    vi.useFakeTimers();
    const sources: FakeSource[] = [];
    const invalidated: string[] = [];
    const bridge = new ProjectEventBridge({
      createEventSource: () => { const source = new FakeSource(); sources.push(source); return source; },
      invalidateProject: (project) => { invalidated.push(project); },
      reload: vi.fn(), ...stableJitter,
    });
    bridge.setProject("p1");
    sources[0].emit("changed");
    sources[0].emit("changed");
    await vi.advanceTimersByTimeAsync(299);
    expect(invalidated).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidated).toEqual(["p1"]);
    sources[0].emit("changed");
    bridge.setProject("p2");
    expect(sources[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(invalidated).toEqual(["p1"]);
  });

  it("reloads only when a later version differs", () => {
    const source = new FakeSource();
    const reload = vi.fn();
    const bridge = new ProjectEventBridge({ createEventSource: () => source, invalidateProject: vi.fn(), reload, ...stableJitter });
    bridge.setProject("p1");
    source.emit("version", JSON.stringify({ version: "a" }));
    source.emit("version", JSON.stringify({ version: "a" }));
    source.emit("version", "bad json");
    source.emit("version", JSON.stringify({ version: "b" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reports a deleted project without reconnecting stale state", async () => {
    const source = new FakeSource();
    const missing = vi.fn();
    const bridge = new ProjectEventBridge({
      createEventSource: () => source,
      invalidateProject: vi.fn(), reload: vi.fn(), probeProject: async () => "missing", onProjectMissing: missing, ...stableJitter,
    });
    bridge.setProject("gone");
    source.onerror?.();
    await vi.waitFor(() => expect(missing).toHaveBeenCalledWith("gone"));
    expect(source.closed).toBe(true);
  });

  it("treats a rejected project probe as transient and retries without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const sources: FakeSource[] = [];
    const statuses: string[] = [];
    const bridge = new ProjectEventBridge({
      createEventSource: () => { const source = new FakeSource(); sources.push(source); return source; },
      invalidateProject: vi.fn(), reload: vi.fn(), probeProject: async () => { throw new Error("network down"); },
      onStatus: (status) => statuses.push(status), failureGraceMs: 0, ...stableJitter,
    });
    bridge.setProject("p1");
    sources[0].onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(999);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(2);
  });

  it("holds live status through brief SSE reconnects until failure grace elapses", async () => {
    vi.useFakeTimers();
    const sources: FakeSource[] = [];
    const statuses: string[] = [];
    const bridge = new ProjectEventBridge({
      createEventSource: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      invalidateProject: vi.fn(),
      reload: vi.fn(),
      probeProject: async () => "available",
      onStatus: (status) => statuses.push(status),
      failureGraceMs: 2_500,
      ...stableJitter,
    });
    bridge.setProject("p1");
    expect(statuses.at(-1)).toBe("connecting");
    sources[0]!.onopen?.();
    expect(statuses.at(-1)).toBe("live");
    sources[0]!.onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    // Still live during grace — no reconnecting flap
    expect(statuses.filter((s) => s === "reconnecting")).toEqual([]);
    expect(statuses.at(-1)).toBe("live");
    // Reopen before grace ends
    await vi.advanceTimersByTimeAsync(1_000);
    sources.at(-1)!.onopen?.();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(statuses.filter((s) => s === "reconnecting")).toEqual([]);
    expect(statuses.at(-1)).toBe("live");
  });

  it("surfaces reconnecting after failure grace when stream stays down", async () => {
    vi.useFakeTimers();
    const sources: FakeSource[] = [];
    const statuses: string[] = [];
    const bridge = new ProjectEventBridge({
      createEventSource: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      invalidateProject: vi.fn(),
      reload: vi.fn(),
      probeProject: async () => "available",
      onStatus: (status) => statuses.push(status),
      failureGraceMs: 2_500,
      retryMs: 10_000,
      ...stableJitter,
    });
    bridge.setProject("p1");
    sources[0]!.onopen?.();
    sources[0]!.onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe("live");
    await vi.advanceTimersByTimeAsync(2_499);
    expect(statuses.filter((s) => s === "reconnecting")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses.at(-1)).toBe("reconnecting");
  });

  it("backs off exponentially to 30s and resets to 1s after an open", async () => {
    vi.useFakeTimers();
    const sources: FakeSource[] = [];
    const bridge = new ProjectEventBridge({
      createEventSource: () => { const source = new FakeSource(); sources.push(source); return source; },
      invalidateProject: vi.fn(), reload: vi.fn(), probeProject: async () => "available", ...stableJitter,
    });
    bridge.setProject("p1");
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      sources.at(-1)!.onerror?.();
      await vi.advanceTimersByTimeAsync(0);
      const count = sources.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sources).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(sources).toHaveLength(count + 1);
    }
    sources.at(-1)!.onopen?.();
    sources.at(-1)!.onerror?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(sources).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(9);
  });

  it("does not let a late probe from the old project schedule a stale reconnect", async () => {
    vi.useFakeTimers();
    const sources: FakeSource[] = [];
    let resolveProbe!: (value: "available") => void;
    const probe = new Promise<"available">((resolve) => { resolveProbe = resolve; });
    const bridge = new ProjectEventBridge({
      createEventSource: () => { const source = new FakeSource(); sources.push(source); return source; },
      invalidateProject: vi.fn(), reload: vi.fn(), probeProject: async (project) => project === "old" ? probe : "available", ...stableJitter,
    });
    bridge.setProject("old");
    sources[0].onerror?.();
    bridge.setProject("new");
    resolveProbe("available");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sources).toHaveLength(2);
    expect(sources[1].closed).toBe(false);
  });

  it("does not carry an old project's backoff into a newly selected project", async () => {
    vi.useFakeTimers();
    const sources: FakeSource[] = [];
    const bridge = new ProjectEventBridge({
      createEventSource: () => { const source = new FakeSource(); sources.push(source); return source; },
      invalidateProject: vi.fn(), reload: vi.fn(), probeProject: async () => "available", ...stableJitter,
    });
    bridge.setProject("old");
    sources[0].onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);
    sources[1].onerror?.();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sources).toHaveLength(3);

    bridge.setProject("new");
    sources[3].onerror?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(sources).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(5);
  });
});
