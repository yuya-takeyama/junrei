import { describe, expect, it } from "vitest";
import type { Learning } from "../api.js";
import { assignColumns, loopHealth } from "./boardColumns.js";

function learning(
  overrides: Partial<Learning> & { id: string; status: Learning["status"] },
): Learning {
  return {
    createdAt: "2026-07-10T00:00:00.000Z",
    repo: "/Users/me/junrei",
    sourceSessions: [],
    finding: "finding",
    change: "change",
    proposedBy: "agent",
    ...overrides,
  } as Learning;
}

describe("assignColumns", () => {
  const learnings: Learning[] = [
    learning({ id: "L-1", status: "open", createdAt: "2026-07-10T00:00:00Z" }),
    learning({ id: "L-2", status: "open", createdAt: "2026-07-12T00:00:00Z" }),
    learning({ id: "L-3", status: "applied" }),
    learning({ id: "L-4", status: "verified" }),
    learning({ id: "L-5", status: "rejected" }),
  ];

  it("routes open→learn, applied→change, verified+rejected→verify", () => {
    const cols = assignColumns(learnings);
    expect(cols.learn.map((l) => l.id)).toEqual(["L-2", "L-1"]); // newest-first
    expect(cols.change.map((l) => l.id)).toEqual(["L-3"]);
    expect(cols.verify.map((l) => l.id).sort()).toEqual(["L-4", "L-5"]);
  });

  it("does not mutate the input array's order", () => {
    const input = [...learnings];
    assignColumns(input);
    expect(input.map((l) => l.id)).toEqual(["L-1", "L-2", "L-3", "L-4", "L-5"]);
  });
});

describe("loopHealth", () => {
  it("counts every status", () => {
    const health = loopHealth([
      learning({ id: "a", status: "open" }),
      learning({ id: "b", status: "applied" }),
      learning({ id: "c", status: "verified" }),
      learning({ id: "d", status: "rejected" }),
      learning({ id: "e", status: "open" }),
    ]);
    expect(health).toMatchObject({ open: 2, applied: 1, verified: 1, rejected: 1 });
  });

  it("sums the verified cost savings/day only from costPerDayUsd verifications", () => {
    const health = loopHealth([
      learning({
        id: "a",
        status: "verified",
        verification: { metric: "costPerDayUsd", before: 30, after: 20, windowDays: 14 },
      }),
      learning({
        id: "b",
        status: "verified",
        verification: { metric: "costPerDayUsd", before: 12, after: 8, windowDays: 14 },
      }),
      // A different metric is ignored — never mixed into the $/day sum.
      learning({
        id: "c",
        status: "verified",
        verification: { metric: "cacheHitRate", before: 0.5, after: 0.9, windowDays: 14 },
      }),
    ]);
    expect(health.verifiedCostSavingsPerDay).toBeCloseTo(14, 6); // (30-20) + (12-8)
  });

  it("returns null savings/cycle time when no verified learning carries the data (no fabrication)", () => {
    const health = loopHealth([
      learning({ id: "a", status: "verified" }),
      learning({ id: "b", status: "open" }),
    ]);
    expect(health.verifiedCostSavingsPerDay).toBeNull();
    expect(health.cycleTimeDays).toBeNull();
  });

  it("averages appliedAt→resolvedAt cycle time across verified learnings that have both", () => {
    const health = loopHealth([
      learning({
        id: "a",
        status: "verified",
        appliedAt: "2026-07-01T00:00:00Z",
        resolvedAt: "2026-07-05T00:00:00Z", // 4 days
      }),
      learning({
        id: "b",
        status: "verified",
        appliedAt: "2026-07-01T00:00:00Z",
        resolvedAt: "2026-07-03T00:00:00Z", // 2 days
      }),
    ]);
    expect(health.cycleTimeDays).toBeCloseTo(3, 6);
  });
});
