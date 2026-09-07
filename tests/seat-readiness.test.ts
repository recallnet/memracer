import { describe, expect, it } from "vitest";
import {
  dismissGetStarted,
  getStartedMode,
  getStartedStorageKey,
  hasCoderSeat,
  hasHumanSeat,
  isFactoryReady,
  seatReadinessState,
  shouldShowGetStarted,
  type ProjectSeatReadiness,
} from "../src/dashboard/web/lib/seat-readiness.js";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function readiness(partial: Partial<ProjectSeatReadiness> = {}): ProjectSeatReadiness {
  return {
    factoryReady: false,
    humanSeats: 0,
    coderSeats: 0,
    hasTaskHistory: false,
    friggReady: false,
    ...partial,
  };
}

describe("seat-readiness", () => {
  it("detects human/coder seats and factory readiness from key lists (Settings)", () => {
    expect(hasHumanSeat([])).toBe(false);
    expect(hasCoderSeat([{ type: "human" }])).toBe(false);
    expect(hasHumanSeat([{ type: "human" }])).toBe(true);
    expect(hasCoderSeat([{ type: "coder" }])).toBe(true);
    expect(isFactoryReady([{ type: "human" }])).toBe(false);
    expect(isFactoryReady([{ type: "human" }, { type: "coder" }])).toBe(true);
    expect(seatReadinessState([])).toBe("empty");
    expect(seatReadinessState([{ type: "coder" }])).toBe("partial");
    expect(seatReadinessState([{ type: "human" }, { type: "coder" }])).toBe("ready");
  });

  it("hides get-started while readiness is loading/unknown", () => {
    const storage = memoryStorage();
    expect(shouldShowGetStarted("demo", null, storage)).toBe(false);
    expect(shouldShowGetStarted("demo", undefined, storage)).toBe(false);
  });

  it("shows get-started for empty greenfield (not ready, no tasks, not dismissed)", () => {
    const storage = memoryStorage();
    expect(shouldShowGetStarted("demo", readiness({ factoryReady: false, hasTaskHistory: false }), storage)).toBe(
      true,
    );
    expect(
      shouldShowGetStarted(
        "demo",
        readiness({ factoryReady: false, humanSeats: 1, coderSeats: 0, hasTaskHistory: false }),
        storage,
      ),
    ).toBe(true);
  });

  it("keeps get-started open at the billing gate once seats connect but no plan", () => {
    const storage = memoryStorage();
    // Both seat types connected but org has no active plan → billing gate, still shown.
    expect(
      shouldShowGetStarted(
        "demo",
        readiness({ factoryReady: true, humanSeats: 2, coderSeats: 1, friggReady: false }),
        storage,
      ),
    ).toBe(true);
    // Task history alone does not hide seat-model teaching
    expect(
      shouldShowGetStarted(
        "demo",
        readiness({ factoryReady: false, humanSeats: 1, coderSeats: 0, hasTaskHistory: true }),
        storage,
      ),
    ).toBe(true);
  });

  it("hides get-started only when seats are connected and billing is active", () => {
    const storage = memoryStorage();
    expect(
      shouldShowGetStarted(
        "demo",
        readiness({ factoryReady: true, humanSeats: 2, coderSeats: 1, friggReady: true }),
        storage,
      ),
    ).toBe(false);
  });

  it("selects the billing gate mode only when seats are ready but unpaid", () => {
    expect(getStartedMode(readiness({ factoryReady: false, friggReady: false }))).toBe("seats");
    expect(getStartedMode(readiness({ factoryReady: true, friggReady: false }))).toBe("billing");
    expect(getStartedMode(readiness({ factoryReady: true, friggReady: true }))).toBe("seats");
  });

  it("hides get-started when dismissed even if greenfield incomplete", () => {
    const storage = memoryStorage();
    const projectId = "demo";
    dismissGetStarted(projectId, storage);
    expect(storage.getItem(getStartedStorageKey(projectId))).toBe("1");
    expect(shouldShowGetStarted(projectId, readiness({ factoryReady: false }), storage)).toBe(false);
  });
});
